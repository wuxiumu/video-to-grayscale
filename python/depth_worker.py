"""Offline relative-depth inference. All decoded frames stay on this machine."""
import argparse
import hashlib
import json
import os
import time
from pathlib import Path

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'

import av
import numpy as np
import torch
from PIL import Image
from transformers import AutoImageProcessor, AutoModelForDepthEstimation

ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT / '.models/depth-anything-v2-small'


def emit(**data):
    print(json.dumps(data), flush=True)


def normalize(depth, low, high, invert=False):
    if not np.isfinite(depth).all():
        raise ValueError('模型产生非有限深度值')
    value = np.clip((depth - low) / max(high - low, 1e-6), 0, 1)
    if invert:
        value = 1 - value
    return np.round(value * 255).astype(np.uint8)


def check_model():
    config = json.loads((ROOT / 'python/model.json').read_text())
    manifest = json.loads((MODEL_DIR / 'download.json').read_text())
    if manifest['revision'] != config['revision']:
        raise ValueError('本地模型版本不匹配，请运行 npm run setup:depth')
    for name, record in manifest['files'].items():
        digest = hashlib.sha256()
        with (MODEL_DIR / name).open('rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(block)
        if digest.hexdigest() != record['sha256']:
            raise ValueError(f'模型文件损坏：{name}，请重新下载')
    return config, manifest


def main(args):
    started = time.perf_counter()
    work = Path(args.work_dir)
    cache = work / 'raw-depth'
    cache.mkdir()
    config, downloaded = check_model()
    device = args.device
    if device == 'auto':
        device = 'mps' if torch.backends.mps.is_available() else 'cpu'
    if device == 'mps' and not torch.backends.mps.is_available():
        raise ValueError('MPS 不可用，请显式选择 --depth-device cpu')
    torch.set_num_threads(min(4, os.cpu_count() or 1))
    emit(phase='loading', device=device)
    processor = AutoImageProcessor.from_pretrained(MODEL_DIR, local_files_only=True, use_fast=False)
    model = AutoModelForDepthEstimation.from_pretrained(MODEL_DIR, local_files_only=True, use_safetensors=True).to(device).eval()
    loaded = time.perf_counter()
    pts = []
    scenes = []
    scene_samples = []
    previous = None
    scene_start = 0
    tensor_shape = None
    inference_seconds = 0.0
    with av.open(args.input, options={'protocol_whitelist': 'file'}) as container:
        stream = container.streams.video[0]
        fps = stream.average_rate
        if not fps or fps <= 0:
            raise ValueError('无法确定视频帧率')
        width, height = stream.width, stream.height
        if max(width, height) / min(width, height) > 2.5:
            raise ValueError('首版深度暂不支持长宽比超过 2.5 的视频，请先裁切')
        for index, frame in enumerate(container.decode(stream)):
            timestamp = float(frame.pts * frame.time_base) if frame.pts is not None else index / float(fps)
            if pts and abs((timestamp - pts[0]) - index / float(fps)) > 0.003:
                raise ValueError('检测到可变帧率；请先将参考视频规范为固定帧率后再生成深度')
            pts.append(timestamp)
            image = frame.to_image()
            small = np.asarray(image.resize((32, 32)), dtype=np.float32) / 255
            cut_score = float(np.mean(np.abs(small - previous))) if previous is not None else 0
            if cut_score > 0.30 and index - scene_start > 2:
                scenes.append({'start': scene_start, 'end': index, 'samples': scene_samples})
                scene_samples = []
                scene_start = index
            previous = small
            inputs = processor(images=image, return_tensors='pt', size={'height': args.size, 'width': args.size})
            tensor_shape = list(inputs['pixel_values'].shape)
            tic = time.perf_counter()
            with torch.inference_mode():
                prediction = model(**{key: value.to(device) for key, value in inputs.items()}).predicted_depth[0]
                depth = prediction.float().cpu().numpy()
            inference_seconds += time.perf_counter() - tic
            if not np.isfinite(depth).all():
                raise ValueError(f'第 {index} 帧产生无效深度')
            np.save(cache / f'{index:08d}.npy', depth.astype(np.float32))
            # Bounded reservoir: deterministic sampling, at most 256 representative frame samples.
            sample = depth[::max(1, depth.shape[0] // 24), ::max(1, depth.shape[1] // 24)].reshape(-1)
            if len(scene_samples) < 256:
                scene_samples.append(sample)
            else:
                slot = int(np.random.default_rng(index).integers(0, index - scene_start + 1))
                if slot < 256:
                    scene_samples[slot] = sample
            emit(phase='inference', frame=index + 1, elapsed=timestamp - pts[0], device=device)
    if not pts:
        raise ValueError('视频没有可解码帧')
    scenes.append({'start': scene_start, 'end': len(pts), 'samples': scene_samples})
    for scene in scenes:
        values = np.concatenate(scene.pop('samples'))
        low, high = np.percentile(values, [2, 98])
        scene.update(low=float(low), high=float(high))
    peak_mps = torch.mps.driver_allocated_memory() if device == 'mps' else None
    del model
    if device == 'mps':
        torch.mps.empty_cache()
    emit(phase='normalizing', frames=len(pts))
    with av.open(str(work / 'depth-lossless.mkv'), mode='w') as output:
        video = output.add_stream('ffv1', rate=fps)
        video.width = width
        video.height = height
        video.pix_fmt = 'gray'
        scene_index = 0
        for index in range(len(pts)):
            while index >= scenes[scene_index]['end']:
                scene_index += 1
            scene = scenes[scene_index]
            depth = np.load(cache / f'{index:08d}.npy', allow_pickle=False)
            resized = np.asarray(Image.fromarray(depth).resize((width, height), Image.Resampling.BILINEAR))
            gray = normalize(resized, scene['low'], scene['high'], args.invert)
            frame = av.VideoFrame.from_ndarray(gray, format='gray')
            frame.pts = index
            frame.time_base = 1 / fps
            for packet in video.encode(frame):
                output.mux(packet)
            if index in {0, len(pts) // 2, len(pts) - 1}:
                Image.fromarray(gray).save(work / f'depth-frame-{index:04d}.png')
        for packet in video.encode():
            output.mux(packet)
    report = {
        'schema': 1, 'model': config, 'weight_sha256': downloaded['files']['model.safetensors']['sha256'],
        'depth_kind': 'relative', 'near_is_white': not args.invert, 'audio': 'none',
        'device': device, 'precision': 'float32', 'frames': len(pts), 'fps': str(fps),
        'width': width, 'height': height, 'normalized_input_pts_seconds': pts,
        'inference_tensor_shape': tensor_shape, 'normalization': 'per-shot percentile 2/98; no temporal averaging',
        'scenes': scenes, 'load_seconds': loaded - started, 'inference_seconds': inference_seconds,
        'mps_driver_bytes_after_inference': peak_mps, 'worker_seconds': time.perf_counter() - started,
        'limitations': ['Relative depth, not meters', 'Framewise network may exhibit temporal drift', 'Scene cuts use a simple RGB difference heuristic'],
    }
    (work / 'manifest.json').write_text(json.dumps(report, indent=2))
    emit(phase='depth_ready', **{key: report[key] for key in ['frames', 'fps', 'device', 'inference_seconds']})


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--work-dir', required=True)
    parser.add_argument('--size', type=int, choices=[392, 518], default=392)
    parser.add_argument('--device', choices=['auto', 'mps', 'cpu'], default='auto')
    parser.add_argument('--invert', action='store_true')
    try:
        main(parser.parse_args())
    except Exception as error:
        import sys
        print(f'Depth error: {error}', file=sys.stderr, flush=True)
        raise SystemExit(1)
