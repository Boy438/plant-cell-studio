"""TripoSR 本地推理（Windows / 无 MSVC 环境适配版）
- 用 skimage 的 marching cubes 替换需要编译的 torchmcubes
- 用 stub 跳过 rembg（输入图自带 alpha 通道）
"""
import os
os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')
import argparse, sys, time, types
import numpy as np

# ---- stub 掉无法在 Windows 上编译的原生依赖 ----
_rb = types.ModuleType('rembg')
_rb.remove = lambda image, **kw: image
sys.modules.setdefault('rembg', _rb)
_tmc = types.ModuleType('torchmcubes')
_tmc.marching_cubes = lambda *a, **k: (None, None)
sys.modules.setdefault('torchmcubes', _tmc)

import torch
from skimage import measure

REPO = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'TripoSR')
sys.path.insert(0, REPO)

from tsr.models import isosurface as iso


def _mc_forward(self, level):
    vol = (-level.view(self.resolution, self.resolution, self.resolution)).detach().cpu().numpy().astype(np.float32)
    verts, faces, _, _ = measure.marching_cubes(vol, level=0.0)
    v = torch.from_numpy(np.ascontiguousarray(verts.astype(np.float32)))[..., [2, 1, 0]] / (self.resolution - 1.0)
    return v.to(level.device), torch.from_numpy(np.ascontiguousarray(faces.astype(np.int64))).to(level.device)


iso.MarchingCubeHelper.forward = _mc_forward

from tsr.system import TSR  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--image', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--resolution', type=int, default=192)
    ap.add_argument('--threshold', type=float, default=25.0)
    ap.add_argument('--foreground-ratio', type=float, default=0.88)
    args = ap.parse_args()

    from PIL import Image
    from tsr.utils import resize_foreground

    dev = 'cuda' if torch.cuda.is_available() else 'cpu'
    print('[1/4] load model on', dev, flush=True)
    t0 = time.time()
    model = TSR.from_pretrained(os.path.join(REPO, 'weights'), config_name='config.yaml', weight_name='model.ckpt')
    model.renderer.set_chunk_size(16384)
    model.to(dev)
    print('      loaded in', round(time.time() - t0, 1), 's', flush=True)

    print('[2/4] encode image', flush=True)
    img = Image.open(args.image).convert('RGBA')
    img = resize_foreground(img, args.foreground_ratio)
    arr = np.array(img).astype(np.float32) / 255.0
    arr = arr[:, :, :3] * arr[:, :, 3:4] + (1 - arr[:, :, 3:4]) * 0.5
    img = Image.fromarray((arr * 255.0).astype(np.uint8))
    scene_codes = model([img], device=dev)

    print('[3/4] extract mesh (skimage marching cubes)', flush=True)
    meshes = model.extract_mesh(scene_codes, True, resolution=args.resolution, threshold=args.threshold)
    mesh = meshes[0]

    print('[4/4] export', flush=True)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    mesh.export(args.out)
    print('OK', args.out, 'verts', len(mesh.vertices), 'faces', len(mesh.faces), 'total', round(time.time() - t0, 1), 's')


if __name__ == '__main__':
    main()
