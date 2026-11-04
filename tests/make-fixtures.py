"""Generate the USD fixtures the parse test consumes.

Blender is the only USD author on this machine that emits all three containers,
so the fixtures are real exporter output rather than hand-written approximations
of one. Run it with the Blender that is already installed:

    & 'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe' --background --python tests/make-fixtures.py

The scene is deliberately small — two meshes, one material — because the test
asserts container dispatch and geometry counts, not exporter fidelity.
"""
import os
import sys

import bpy

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


def main() -> int:
    os.makedirs(OUT, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)

    bpy.ops.mesh.primitive_cube_add(size=2.0, location=(0.0, 0.0, 0.0))
    cube = bpy.context.active_object
    cube.name = "FixtureCube"

    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.6, location=(1.6, 0.0, 0.0))
    sphere = bpy.context.active_object
    sphere.name = "FixtureSphere"

    material = bpy.data.materials.new("FixtureMaterial")
    material.use_nodes = True
    material.diffuse_color = (0.2, 0.5, 0.9, 1.0)
    cube.data.materials.append(material)

    written = []
    # Blender 5.2's exporter takes no format keyword: the container follows the
    # file extension (`.usda` ASCII, `.usdc` crate, `.usdz` package).
    for suffix in ("usda", "usdc", "usdz"):
        path = os.path.join(OUT, f"sample.{suffix}")
        bpy.ops.wm.usd_export(filepath=path)
        written.append((path, os.path.getsize(path)))

    # `.usd` may hold the ASCII encoding or the crate; ship the ASCII one so the
    # ambiguous suffix is covered by a file whose container is decided by bytes.
    ascii_path = os.path.join(OUT, "sample.usd")
    with open(os.path.join(OUT, "sample.usda"), "rb") as source, open(ascii_path, "wb") as target:
        target.write(source.read())
    written.append((ascii_path, os.path.getsize(ascii_path)))

    for path, size in written:
        print(f"FIXTURE {os.path.basename(path)} {size} bytes")
    print("FIXTURES OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
