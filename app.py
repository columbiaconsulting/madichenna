"""
Flask backend for the Golf Ball Flight Tracer web app.
"""

import os
import uuid
import threading
import traceback
import json

from flask import Flask, request, jsonify, render_template, send_file
from tracker import process_video, process_video_manual

app = Flask(__name__)

# 500 MB upload limit
app.config["MAX_CONTENT_LENGTH"] = 500 * 1024 * 1024

UPLOAD_FOLDER = os.path.join(os.path.dirname(__file__), "uploads")
OUTPUT_FOLDER = os.path.join(os.path.dirname(__file__), "outputs")

os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(OUTPUT_FOLDER, exist_ok=True)

# In-memory job tracking
# job_id -> {status, progress, stats, error}
jobs = {}


def run_processing(job_id, input_path, output_path):
    """Background thread: run ball detection and update job status."""
    try:
        jobs[job_id]["status"] = "processing"

        def progress_callback(p):
            jobs[job_id]["progress"] = round(p * 100, 1)

        stats = process_video(input_path, output_path, progress_callback=progress_callback)

        jobs[job_id]["status"] = "done"
        jobs[job_id]["progress"] = 100.0
        jobs[job_id]["stats"] = stats

    except Exception as exc:
        jobs[job_id]["status"] = "error"
        jobs[job_id]["error"] = str(exc)
        traceback.print_exc()

    finally:
        # Clean up input file
        if os.path.exists(input_path):
            try:
                os.remove(input_path)
            except OSError:
                pass


def run_manual_processing(job_id, input_path, output_path, points):
    """Background thread: run manual trace and update job status."""
    try:
        jobs[job_id]["status"] = "processing"

        def progress_callback(p):
            jobs[job_id]["progress"] = round(p * 100, 1)

        stats = process_video_manual(input_path, output_path, points, progress_callback=progress_callback)

        jobs[job_id]["status"] = "done"
        jobs[job_id]["progress"] = 100.0
        jobs[job_id]["stats"] = stats

    except Exception as exc:
        jobs[job_id]["status"] = "error"
        jobs[job_id]["error"] = str(exc)
        traceback.print_exc()

    finally:
        if os.path.exists(input_path):
            try:
                os.remove(input_path)
            except OSError:
                pass


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/upload", methods=["POST"])
def upload():
    if "video" not in request.files:
        return jsonify({"error": "No video file provided"}), 400

    video_file = request.files["video"]
    if video_file.filename == "":
        return jsonify({"error": "Empty filename"}), 400

    job_id = str(uuid.uuid4())

    # Save uploaded file
    ext = os.path.splitext(video_file.filename)[1] or ".mp4"
    input_path = os.path.join(UPLOAD_FOLDER, f"{job_id}{ext}")
    output_path = os.path.join(OUTPUT_FOLDER, f"{job_id}_traced.mp4")

    video_file.save(input_path)

    # Initialize job record
    jobs[job_id] = {
        "status": "queued",
        "progress": 0.0,
        "stats": None,
        "error": None,
        "output_path": output_path,
    }

    mode = request.form.get("mode", "auto")
    points_raw = request.form.get("points", None)

    if mode == "manual" and points_raw:
        try:
            manual_points = json.loads(points_raw)
        except (ValueError, TypeError):
            return jsonify({"error": "Invalid points data"}), 400
        thread = threading.Thread(
            target=run_manual_processing,
            args=(job_id, input_path, output_path, manual_points),
            daemon=True,
        )
    else:
        thread = threading.Thread(
            target=run_processing,
            args=(job_id, input_path, output_path),
            daemon=True,
        )
    thread.start()

    return jsonify({"job_id": job_id})


@app.route("/status/<job_id>")
def status(job_id):
    if job_id not in jobs:
        return jsonify({"error": "Unknown job"}), 404

    job = jobs[job_id]
    return jsonify(
        {
            "status": job["status"],
            "progress": job["progress"],
            "stats": job["stats"],
            "error": job["error"],
        }
    )


@app.route("/result/<job_id>")
def result(job_id):
    if job_id not in jobs:
        return jsonify({"error": "Unknown job"}), 404

    job = jobs[job_id]

    if job["status"] != "done":
        return jsonify({"error": "Job not complete"}), 400

    output_path = job["output_path"]
    if not os.path.exists(output_path):
        return jsonify({"error": "Output file not found"}), 404

    return send_file(
        output_path,
        mimetype="video/mp4",
        as_attachment=False,
        download_name=f"golf_traced_{job_id[:8]}.mp4",
    )


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(debug=True, host="0.0.0.0", port=port)
