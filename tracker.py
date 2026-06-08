"""
Golf ball detection and trajectory tracking using OpenCV.
"""

import cv2
import numpy as np
import math
import os
import shutil
import subprocess
import tempfile


def _open_writer(path, fps, width, height):
    """Write frames with mp4v — reliable on all platforms, no DLL needed."""
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(path, fourcc, fps, (width, height))
    if not writer.isOpened():
        raise RuntimeError("Could not open VideoWriter — check OpenCV installation")
    return writer


def _get_ffmpeg():
    """Return path to ffmpeg: system install first, then imageio's bundled binary."""
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        return ffmpeg
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def _finalize_video(tmp_path, final_path):
    """
    Re-encode to H.264 (browser-compatible) using ffmpeg or imageio's bundled binary.
    Falls back to the raw mp4v file if neither is available.
    """
    ffmpeg = _get_ffmpeg()
    if ffmpeg:
        try:
            r = subprocess.run(
                [
                    ffmpeg, "-y", "-i", tmp_path,
                    "-c:v", "libx264", "-preset", "fast", "-crf", "23",
                    "-movflags", "+faststart",
                    final_path,
                ],
                capture_output=True,
                timeout=600,
            )
            if r.returncode == 0:
                os.remove(tmp_path)
                return
        except Exception:
            pass
    # Last resort: use the mp4v file as-is
    os.replace(tmp_path, final_path)


def detect_ball_in_frame(frame, bg_sub, history):
    """
    Detect golf ball in a single frame.

    Args:
        frame: BGR image (already at processing resolution)
        bg_sub: cv2 background subtractor (MOG2)
        history: list of recent (cx, cy) positions (may contain None)

    Returns:
        (cx, cy) tuple or None if not detected
    """
    # Apply background subtraction
    fg_mask = bg_sub.apply(frame)

    # Morphological cleanup on the foreground mask
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    fg_mask = cv2.morphologyEx(fg_mask, cv2.MORPH_OPEN, kernel)
    fg_mask = cv2.dilate(fg_mask, kernel, iterations=1)

    # Build color mask in HSV space for white and yellow golf balls
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)

    # White: low saturation, high value
    white_lower = np.array([0, 0, 170], dtype=np.uint8)
    white_upper = np.array([180, 60, 255], dtype=np.uint8)
    white_mask = cv2.inRange(hsv, white_lower, white_upper)

    # Yellow: hue 18-38, high saturation, high value
    yellow_lower = np.array([18, 80, 150], dtype=np.uint8)
    yellow_upper = np.array([38, 255, 255], dtype=np.uint8)
    yellow_mask = cv2.inRange(hsv, yellow_lower, yellow_upper)

    color_mask = cv2.bitwise_or(white_mask, yellow_mask)

    # Combine foreground and color masks
    combined = cv2.bitwise_and(fg_mask, color_mask)

    # Find contours in combined mask
    contours, _ = cv2.findContours(combined, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    # Also try just color mask if combined yields nothing
    if len(contours) == 0:
        contours, _ = cv2.findContours(color_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    candidates = []

    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < 5 or area > 800:
            continue

        perimeter = cv2.arcLength(cnt, True)
        if perimeter == 0:
            continue

        circularity = (4 * math.pi * area) / (perimeter * perimeter)
        if circularity < 0.55:
            continue

        M = cv2.moments(cnt)
        if M["m00"] == 0:
            continue

        cx = int(M["m10"] / M["m00"])
        cy = int(M["m01"] / M["m00"])

        candidates.append((cx, cy, area, circularity))

    if not candidates:
        return None

    if len(candidates) == 1:
        return (candidates[0][0], candidates[0][1])

    # Score candidates by trajectory consistency
    # Get the last two known positions from history
    known = [pos for pos in history if pos is not None]

    if len(known) < 2:
        # No trajectory info — pick candidate closest to last known or largest/most circular
        if len(known) == 1:
            lx, ly = known[-1]
            best = min(candidates, key=lambda c: math.hypot(c[0] - lx, c[1] - ly))
        else:
            # Pick highest circularity
            best = max(candidates, key=lambda c: c[3])
        return (best[0], best[1])

    # Linear extrapolation from last two positions
    px, py = known[-2]
    lx, ly = known[-1]
    ex = lx + (lx - px)
    ey = ly + (ly - py)

    def candidate_score(c):
        dist = math.hypot(c[0] - ex, c[1] - ey)
        # Combine distance score with circularity bonus
        return dist - c[3] * 10

    best = min(candidates, key=candidate_score)
    return (best[0], best[1])


def smooth_trajectory(positions):
    """
    Remove single-frame outliers from trajectory.

    Args:
        positions: list of (cx, cy) or None

    Returns:
        Cleaned list with same length, outliers replaced by None
    """
    result = list(positions)
    n = len(result)

    for i in range(1, n - 1):
        if result[i] is None:
            continue

        prev_pos = None
        for j in range(i - 1, -1, -1):
            if result[j] is not None:
                prev_pos = result[j]
                break

        next_pos = None
        for j in range(i + 1, n):
            if result[j] is not None:
                next_pos = result[j]
                break

        if prev_pos is None or next_pos is None:
            continue

        # Linear interpolation between prev and next
        interp_x = (prev_pos[0] + next_pos[0]) / 2
        interp_y = (prev_pos[1] + next_pos[1]) / 2

        actual_x, actual_y = result[i]
        dist = math.hypot(actual_x - interp_x, actual_y - interp_y)

        # If point is too far from interpolated position, mark as outlier
        if dist > 150:
            result[i] = None

    # Pass 2: remove isolated detections with no neighbours within 8 frames
    result2 = list(result)
    for i in range(n):
        if result[i] is None:
            continue
        has_neighbour = any(
            result[j] is not None
            for j in range(max(0, i - 8), min(n, i + 9))
            if j != i
        )
        if not has_neighbour:
            result2[i] = None

    return result2


def filter_by_parabola(positions):
    """Remove positions that don't fit a parabolic ball-flight path."""
    pts = [(i, pos) for i, pos in enumerate(positions) if pos is not None]
    if len(pts) < 8:
        return positions

    indices = np.array([p[0] for p in pts], dtype=float)
    xs = np.array([p[1][0] for p in pts], dtype=float)
    ys = np.array([p[1][1] for p in pts], dtype=float)

    try:
        poly_y = np.polyfit(indices, ys, 2)
        poly_x = np.polyfit(indices, xs, 1)

        y_range = max(ys) - min(ys)
        threshold = max(60, y_range * 0.25)

        result = list(positions)
        for i, pos in enumerate(positions):
            if pos is None:
                continue
            pred_x = np.polyval(poly_x, i)
            pred_y = np.polyval(poly_y, i)
            if math.hypot(pos[0] - pred_x, pos[1] - pred_y) > threshold:
                result[i] = None
        return result
    except Exception:
        return positions


def draw_trajectory_on_frame(frame, trajectory, current_idx):
    """
    Draw the ball trajectory on a frame.

    Args:
        frame: BGR image to draw on (modified in-place)
        trajectory: list of (cx, cy) or None positions (full-res coords)
        current_idx: index of current frame in trajectory

    Returns:
        Modified frame
    """
    # Determine the window of positions to draw (up to last 40)
    start_idx = max(0, current_idx - 39)
    window = trajectory[start_idx : current_idx + 1]

    # Filter to only valid positions, keeping their relative index for color
    valid_points = []
    for rel_idx, pos in enumerate(window):
        if pos is not None:
            valid_points.append((rel_idx, pos))

    num_valid = len(valid_points)

    # Draw gradient line segments
    for i in range(1, num_valid):
        rel_i = valid_points[i][0]
        t = rel_i / max(len(window) - 1, 1)  # 0=oldest, 1=newest

        # Dark red gradient: older=dark red, newer=bright red
        r = int(80 + 120 * t)   # 80 → 200
        color = (0, 0, r)
        pt1 = valid_points[i - 1][1]
        pt2 = valid_points[i][1]
        cv2.line(frame, pt1, pt2, color, 3, cv2.LINE_AA)

    # Draw current ball position with dark red glow
    if current_idx < len(trajectory) and trajectory[current_idx] is not None:
        cx, cy = trajectory[current_idx]
        cv2.circle(frame, (cx, cy), 12, (0, 0, 180), 2, cv2.LINE_AA)
        cv2.circle(frame, (cx, cy), 9,  (0, 0, 140), 2, cv2.LINE_AA)
        cv2.circle(frame, (cx, cy), 6,  (0, 0, 200), -1, cv2.LINE_AA)
        cv2.circle(frame, (cx, cy), 3,  (200, 200, 255), -1, cv2.LINE_AA)

    # Label detected frames count
    detected = sum(1 for p in trajectory[: current_idx + 1] if p is not None)
    label = f"Ball detected: {detected} frames"
    font = cv2.FONT_HERSHEY_SIMPLEX
    font_scale = 0.7
    thickness = 2
    (text_w, text_h), baseline = cv2.getTextSize(label, font, font_scale, thickness)

    # Background rectangle
    cv2.rectangle(
        frame,
        (8, 8),
        (text_w + 16, text_h + baseline + 16),
        (0, 0, 0),
        -1,
    )
    cv2.putText(
        frame,
        label,
        (12, text_h + 12),
        font,
        font_scale,
        (100, 255, 100),
        thickness,
        cv2.LINE_AA,
    )

    return frame


def process_video(input_path, output_path, progress_callback=None):
    """
    Process a golf video: detect ball positions, draw trajectory, save annotated video.

    Args:
        input_path: path to input video file
        output_path: path to save annotated video
        progress_callback: optional callable(progress_float 0.0-1.0)

    Returns:
        dict with keys: total_frames, detected_frames, fps, duration_seconds
    """
    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {input_path}")

    orig_width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    orig_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    # Determine processing scale (max 720p)
    max_dim = 720
    if orig_height > max_dim or orig_width > max_dim:
        scale = max_dim / max(orig_height, orig_width)
    else:
        scale = 1.0

    proc_width = int(orig_width * scale)
    proc_height = int(orig_height * scale)

    # Background subtractor
    bg_sub = cv2.createBackgroundSubtractorMOG2(
        history=300, varThreshold=60, detectShadows=False
    )

    # -----------------------------------------------------------------------
    # PASS 1: Detect ball positions in every frame
    # -----------------------------------------------------------------------
    positions = []  # list of (cx_proc, cy_proc) or None (at proc resolution)
    history = []

    frame_idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break

        if scale != 1.0:
            proc_frame = cv2.resize(frame, (proc_width, proc_height))
        else:
            proc_frame = frame

        pos = detect_ball_in_frame(proc_frame, bg_sub, history[-5:] if history else [])
        positions.append(pos)
        history.append(pos)

        frame_idx += 1
        if progress_callback and frame_idx % 10 == 0:
            progress = 0.5 * min(frame_idx / max(total_frames, 1), 1.0)
            progress_callback(progress)

    cap.release()

    # Smooth the trajectory
    positions = smooth_trajectory(positions)
    positions = filter_by_parabola(positions)

    # Upscale positions back to original resolution
    if scale != 1.0:
        upscaled = []
        for pos in positions:
            if pos is None:
                upscaled.append(None)
            else:
                ux = int(pos[0] / scale)
                uy = int(pos[1] / scale)
                upscaled.append((ux, uy))
        positions = upscaled

    detected_frames = sum(1 for p in positions if p is not None)
    actual_total = len(positions)

    # -----------------------------------------------------------------------
    # PASS 2: Draw trajectory and write output video
    # -----------------------------------------------------------------------
    cap2 = cv2.VideoCapture(input_path)
    if not cap2.isOpened():
        raise RuntimeError(f"Cannot re-open video: {input_path}")

    tmp_path = output_path + ".tmp.mp4"
    out = _open_writer(tmp_path, fps, orig_width, orig_height)

    frame_idx = 0
    while True:
        ret, frame = cap2.read()
        if not ret:
            break

        if frame_idx < len(positions):
            draw_trajectory_on_frame(frame, positions, frame_idx)

        out.write(frame)
        frame_idx += 1

        if progress_callback and frame_idx % 10 == 0:
            progress = 0.5 + 0.5 * min(frame_idx / max(actual_total, 1), 1.0)
            progress_callback(progress)

    cap2.release()
    out.release()
    _finalize_video(tmp_path, output_path)

    if progress_callback:
        progress_callback(1.0)

    duration_seconds = actual_total / fps if fps > 0 else 0

    return {
        "total_frames": actual_total,
        "detected_frames": detected_frames,
        "fps": round(fps, 2),
        "duration_seconds": round(duration_seconds, 2),
    }


def process_video_manual(input_path, output_path, points, progress_callback=None):
    """
    Render trajectory from manually specified positions.
    points: list of dicts with keys time (seconds, float), x (0-1), y (0-1)
    """
    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {input_path}")

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.release()

    if len(points) < 2:
        raise ValueError("At least 2 manual points are required")

    # Convert normalised time-based points to pixel frame positions.
    # Sort by time first so ordering is stable.
    sorted_pts = sorted(points, key=lambda p: float(p["time"]))
    keyframes = {}
    for pt in sorted_pts:
        fidx = int(round(float(pt["time"]) * fps))
        fidx = max(0, min(fidx, total_frames - 1))
        # If this frame index is already taken, nudge forward by 1 until free
        while fidx in keyframes and fidx < total_frames - 1:
            fidx += 1
        keyframes[fidx] = (int(float(pt["x"]) * width), int(float(pt["y"]) * height))

    sorted_keys = sorted(keyframes)

    # Build full positions list by linear interpolation between keyframes
    positions = [None] * total_frames
    for i in range(len(sorted_keys) - 1):
        f1, f2 = sorted_keys[i], sorted_keys[i + 1]
        p1, p2 = keyframes[f1], keyframes[f2]
        span = max(f2 - f1, 1)
        for f in range(f1, f2 + 1):
            t = (f - f1) / span
            positions[f] = (int(p1[0] + (p2[0] - p1[0]) * t),
                            int(p1[1] + (p2[1] - p1[1]) * t))

    # Also fill in the last keyframe
    positions[sorted_keys[-1]] = keyframes[sorted_keys[-1]]

    detected = sum(1 for p in positions if p is not None)

    # Render
    cap2 = cv2.VideoCapture(input_path)
    tmp_path = output_path + ".tmp.mp4"
    out = _open_writer(tmp_path, fps, width, height)

    frame_idx = 0
    while True:
        ret, frame = cap2.read()
        if not ret:
            break
        if frame_idx < len(positions):
            draw_trajectory_on_frame(frame, positions, frame_idx)
        out.write(frame)
        frame_idx += 1
        if progress_callback and frame_idx % 10 == 0:
            progress_callback(frame_idx / max(total_frames, 1))

    cap2.release()
    out.release()
    _finalize_video(tmp_path, output_path)
    if progress_callback:
        progress_callback(1.0)

    return {
        "total_frames": total_frames,
        "detected_frames": detected,
        "fps": round(fps, 2),
        "duration_seconds": round(total_frames / fps, 2),
    }
