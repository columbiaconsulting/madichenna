/**
 * Golf Ball Tracer — Frontend application logic
 * Vanilla JS, no frameworks.
 */

(function () {
  "use strict";

  /* ------------------------------------------------------------------ */
  /*  State management                                                    */
  /* ------------------------------------------------------------------ */

  const STATES = ["upload", "processing", "result", "manual"];
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

  var modeAutoBtn      = document.getElementById("mode-auto-btn");
  var modeManualBtn    = document.getElementById("mode-manual-btn");
  var manualVideo      = document.getElementById("manual-video");
  var manualCanvas     = document.getElementById("manual-canvas");
  var pointCountEl     = document.getElementById("point-count");
  var undoBtn          = document.getElementById("undo-btn");
  var applyManualBtn   = document.getElementById("apply-manual-btn");
  var cancelManualBtn  = document.getElementById("cancel-manual-btn");

  /* ------------------------------------------------------------------ */
  /*  Mode selection                                                      */
  /* ------------------------------------------------------------------ */

  var traceMode = "auto";

  modeAutoBtn.addEventListener("click", function () {
    traceMode = "auto";
    modeAutoBtn.classList.add("active");
    modeManualBtn.classList.remove("active");
  });

  modeManualBtn.addEventListener("click", function () {
    traceMode = "manual";
    modeManualBtn.classList.add("active");
    modeAutoBtn.classList.remove("active");
  });

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

    if (traceMode === "manual") {
      openManualEditor(file);
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

      // Wire download button to dedicated download route
      downloadBtn.onclick = function () {
        window.location.href = "/download/" + jobId;
      };

      // Video error feedback
      var videoErrorEl = document.getElementById("video-error");
      resultVideo.onerror = function () {
        if (videoErrorEl) videoErrorEl.textContent = "Video could not be played in browser — use the Download button to watch it.";
      };
      resultVideo.oncanplay = function () {
        if (videoErrorEl) videoErrorEl.textContent = "";
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
  /*  Manual editor                                                       */
  /* ------------------------------------------------------------------ */

  var manualPoints = [];
  var manualObjectUrl = null;
  var videoCanvasWrapper = document.getElementById("video-canvas-wrapper");
  var markPointBtn = document.getElementById("mark-point-btn");

  function openManualEditor(file) {
    manualPoints = [];
    if (manualObjectUrl) URL.revokeObjectURL(manualObjectUrl);
    manualObjectUrl = URL.createObjectURL(file);
    manualVideo.src = manualObjectUrl;
    manualVideo.load();
    updatePointUI();
    exitMarkingMode();
    showState("manual");

    manualVideo.addEventListener("loadedmetadata", syncCanvasSize, { once: true });
  }

  function syncCanvasSize() {
    manualCanvas.width = manualVideo.videoWidth;
    manualCanvas.height = manualVideo.videoHeight;
    redrawPoints();
  }

  function enterMarkingMode() {
    manualVideo.pause();
    videoCanvasWrapper.classList.add("marking-active");
    markPointBtn.classList.add("active");
    markPointBtn.textContent = "Tap the ball on the video…";
  }

  function exitMarkingMode() {
    videoCanvasWrapper.classList.remove("marking-active");
    markPointBtn.classList.remove("active");
    markPointBtn.textContent = "📍 Mark Ball Position";
  }

  markPointBtn.addEventListener("click", function () {
    if (videoCanvasWrapper.classList.contains("marking-active")) {
      exitMarkingMode();
    } else {
      enterMarkingMode();
    }
  });

  function recordPoint(x, y) {
    manualPoints.push({ x: x, y: y, time: manualVideo.currentTime });
    exitMarkingMode();
    updatePointUI();
    redrawPoints();
  }

  manualCanvas.addEventListener("click", function (e) {
    e.preventDefault();
    var rect = manualCanvas.getBoundingClientRect();
    recordPoint(
      (e.clientX - rect.left) / rect.width,
      (e.clientY - rect.top) / rect.height
    );
  });

  manualCanvas.addEventListener("touchend", function (e) {
    e.preventDefault();
    var touch = e.changedTouches[0];
    var rect = manualCanvas.getBoundingClientRect();
    recordPoint(
      (touch.clientX - rect.left) / rect.width,
      (touch.clientY - rect.top) / rect.height
    );
  });

  undoBtn.addEventListener("click", function () {
    manualPoints.pop();
    updatePointUI();
    redrawPoints();
  });

  function updatePointUI() {
    var n = manualPoints.length;
    pointCountEl.textContent = n + (n === 1 ? " point marked" : " points marked");
    applyManualBtn.disabled = n < 2;
  }

  function redrawPoints() {
    var ctx = manualCanvas.getContext("2d");
    ctx.clearRect(0, 0, manualCanvas.width, manualCanvas.height);
    manualPoints.forEach(function (pt, i) {
      var px = pt.x * manualCanvas.width;
      var py = pt.y * manualCanvas.height;
      // glow
      ctx.beginPath();
      ctx.arc(px, py, 10, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(180,0,0,0.25)";
      ctx.fill();
      // dot
      ctx.beginPath();
      ctx.arc(px, py, 6, 0, Math.PI * 2);
      ctx.fillStyle = "#c00000";
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // number
      ctx.fillStyle = "#fff";
      ctx.font = "bold 9px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(i + 1, px, py);
    });
    // draw lines between points
    if (manualPoints.length > 1) {
      ctx.beginPath();
      ctx.strokeStyle = "rgba(180,0,0,0.5)";
      ctx.lineWidth = 2;
      manualPoints.forEach(function (pt, i) {
        var px = pt.x * manualCanvas.width;
        var py = pt.y * manualCanvas.height;
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      });
      ctx.stroke();
    }
  }

  applyManualBtn.addEventListener("click", function () {
    var file = videoInput.files && videoInput.files[0];
    if (!file || manualPoints.length < 2) return;

    showState("processing");
    setProgress(0, "Uploading video…");

    var formData = new FormData();
    formData.append("video", file);
    formData.append("mode", "manual");
    formData.append("points", JSON.stringify(manualPoints));

    fetch("/upload", { method: "POST", body: formData })
      .then(function (res) {
        if (!res.ok) return res.json().then(function (b) { throw new Error(b.error || "Upload failed"); });
        return res.json();
      })
      .then(function (data) {
        currentJobId = data.job_id;
        setProgress(0, "Processing manual trace…");
        startPolling(currentJobId);
      })
      .catch(function (err) {
        showUploadError(err.message || "Upload failed. Please try again.");
      });
  });

  cancelManualBtn.addEventListener("click", function () {
    manualVideo.pause();
    manualVideo.removeAttribute("src");
    manualPoints = [];
    exitMarkingMode();
    if (manualObjectUrl) { URL.revokeObjectURL(manualObjectUrl); manualObjectUrl = null; }
    showState("upload");
  });

  /* ------------------------------------------------------------------ */
  /*  Initialise: show upload state                                       */
  /* ------------------------------------------------------------------ */

  showState("upload");
})();
