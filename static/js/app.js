/**
 * Golf Ball Tracer — Frontend application logic
 * Vanilla JS, no frameworks.
 */

(function () {
  "use strict";

  /* ------------------------------------------------------------------ */
  /*  State management                                                    */
  /* ------------------------------------------------------------------ */

  const STATES = ["upload", "processing", "result"];
  let currentJobId = null;
  let pollTimer = null;

  /**
   * Show a named state section, hide all others.
   * @param {string} name  One of: "upload" | "processing" | "result"
   */
  function showState(name) {
    STATES.forEach(function (s) {
      var el = document.getElementById("state-" + s);
      if (el) {
        el.classList.toggle("active", s === name);
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Element references                                                  */
  /* ------------------------------------------------------------------ */

  var videoInput       = document.getElementById("video-input");
  var processBtn       = document.getElementById("process-btn");
  var uploadFilename   = document.getElementById("upload-filename");
  var uploadError      = document.getElementById("upload-error");

  var processingStatus = document.getElementById("processing-status");
  var progressBar      = document.getElementById("progress-bar");
  var progressText     = document.getElementById("progress-text");

  var resultVideo      = document.getElementById("result-video");
  var statsGrid        = document.getElementById("stats-grid");
  var downloadBtn      = document.getElementById("download-btn");
  var retryBtn         = document.getElementById("retry-btn");

  /* ------------------------------------------------------------------ */
  /*  Upload state: file selection                                        */
  /* ------------------------------------------------------------------ */

  videoInput.addEventListener("change", function () {
    var file = videoInput.files && videoInput.files[0];
    uploadError.textContent = "";

    if (!file) {
      uploadFilename.textContent = "";
      processBtn.disabled = true;
      return;
    }

    // Validate MIME type (accept attribute handles most cases, but double-check)
    if (!file.type.startsWith("video/")) {
      uploadError.textContent = "Please select a video file.";
      uploadFilename.textContent = "";
      processBtn.disabled = true;
      videoInput.value = "";
      return;
    }

    // Show selected filename and enable the process button
    uploadFilename.textContent = file.name;
    processBtn.disabled = false;
  });

  /* ------------------------------------------------------------------ */
  /*  Upload state: form submission                                       */
  /* ------------------------------------------------------------------ */

  processBtn.addEventListener("click", function () {
    var file = videoInput.files && videoInput.files[0];
    if (!file) {
      uploadError.textContent = "No file selected.";
      return;
    }

    var formData = new FormData();
    formData.append("video", file);

    // Switch to processing view immediately
    showState("processing");
    setProgress(0, "Uploading video…");

    fetch("/upload", {
      method: "POST",
      body: formData,
    })
      .then(function (res) {
        if (!res.ok) {
          return res.json().then(function (body) {
            throw new Error(body.error || "Upload failed (" + res.status + ")");
          });
        }
        return res.json();
      })
      .then(function (data) {
        currentJobId = data.job_id;
        setProgress(0, "Processing…");
        startPolling(currentJobId);
      })
      .catch(function (err) {
        showUploadError(err.message || "Upload failed. Please try again.");
      });
  });

  /* ------------------------------------------------------------------ */
  /*  Progress helpers                                                    */
  /* ------------------------------------------------------------------ */

  function setProgress(percent, message) {
    var pct = Math.min(Math.max(percent, 0), 100);
    progressBar.style.width = pct + "%";
    progressText.textContent = Math.round(pct) + "%";
    if (message) {
      processingStatus.textContent = message;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Status polling                                                      */
  /* ------------------------------------------------------------------ */

  function startPolling(jobId) {
    if (pollTimer) {
      clearInterval(pollTimer);
    }
    pollTimer = setInterval(function () {
      pollStatus(jobId);
    }, 1500);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function pollStatus(jobId) {
    fetch("/status/" + jobId)
      .then(function (res) {
        if (!res.ok) {
          throw new Error("Status check failed (" + res.status + ")");
        }
        return res.json();
      })
      .then(function (data) {
        var status = data.status;
        var progress = data.progress || 0;

        if (status === "queued") {
          setProgress(progress, "Queued…");
        } else if (status === "processing") {
          var msg = progress < 50
            ? "Detecting ball positions…"
            : "Drawing trajectory…";
          setProgress(progress, msg);
        } else if (status === "done") {
          stopPolling();
          setProgress(100, "Complete!");
          showResults(jobId, data.stats);
        } else if (status === "error") {
          stopPolling();
          showUploadError(data.error || "Processing failed. Please try again.");
        }
      })
      .catch(function (err) {
        // Non-fatal network blip — keep polling
        console.warn("Poll error:", err);
      });
  }

  /* ------------------------------------------------------------------ */
  /*  Result state                                                        */
  /* ------------------------------------------------------------------ */

  function showResults(jobId, stats) {
    // Small delay so user sees "100%" for a moment
    setTimeout(function () {
      // Set video source
      resultVideo.src = "/result/" + jobId;
      resultVideo.load();

      // Populate stats grid
      statsGrid.innerHTML = "";
      if (stats) {
        var statItems = [
          { value: stats.detected_frames, label: "Frames Detected" },
          { value: formatDuration(stats.duration_seconds), label: "Duration" },
          { value: stats.total_frames, label: "Total Frames" },
          { value: (stats.fps || 0) + " fps", label: "Frame Rate" },
        ];
        statItems.forEach(function (item) {
          var card = document.createElement("div");
          card.className = "stat-card";
          card.innerHTML =
            '<span class="stat-value">' + item.value + "</span>" +
            '<span class="stat-label">' + item.label + "</span>";
          statsGrid.appendChild(card);
        });
      }

      // Wire download button
      downloadBtn.onclick = function () {
        var a = document.createElement("a");
        a.href = "/result/" + jobId;
        a.download = "golf_traced_" + jobId.slice(0, 8) + ".mp4";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      };

      showState("result");
    }, 600);
  }

  function formatDuration(seconds) {
    if (!seconds && seconds !== 0) return "—";
    var s = Math.round(seconds);
    var m = Math.floor(s / 60);
    var sec = s % 60;
    if (m === 0) return sec + "s";
    return m + "m " + sec + "s";
  }

  /* ------------------------------------------------------------------ */
  /*  Error recovery                                                      */
  /* ------------------------------------------------------------------ */

  function showUploadError(message) {
    stopPolling();
    uploadError.textContent = message;
    showState("upload");
  }

  /* ------------------------------------------------------------------ */
  /*  "Trace Another" button                                              */
  /* ------------------------------------------------------------------ */

  retryBtn.addEventListener("click", function () {
    // Reset video element to avoid stale src
    resultVideo.pause();
    resultVideo.removeAttribute("src");
    resultVideo.load();

    // Clear stats
    statsGrid.innerHTML = "";

    // Clear upload state
    videoInput.value = "";
    uploadFilename.textContent = "";
    uploadError.textContent = "";
    processBtn.disabled = true;

    // Reset progress
    setProgress(0, "");

    currentJobId = null;
    stopPolling();

    showState("upload");
  });

  /* ------------------------------------------------------------------ */
  /*  Initialise: show upload state                                       */
  /* ------------------------------------------------------------------ */

  showState("upload");
})();
