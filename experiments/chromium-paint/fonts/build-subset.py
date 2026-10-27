"""Rebuild the trusted fixture font using fonttools==4.60.2.

Usage: python build-subset.py /path/to/NotoSansCJKsc-Regular.otf
The source font SHA-256 is pinned below. No network or runtime dependency.
"""
import hashlib
import pathlib
import sys
from fontTools import subset
from fontTools.ttLib import TTFont

root = pathlib.Path(__file__).resolve().parent
source = pathlib.Path(sys.argv[1])
assert hashlib.sha256(source.read_bytes()).hexdigest() == "2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b", "Unexpected source font"
font = TTFont(source, recalcTimestamp=False)
options = subset.Options()
options.name_IDs = ["*"]
options.name_languages = ["*"]
subsetter = subset.Subsetter(options=options)
text = "".join((root.parent / file).read_text() for file in ["fixture.html", "fixture.js", "fixture.css"])
subsetter.populate(unicodes=set(range(0x20, 0x7f)) | {ord(char) for char in text if ord(char) >= 0x80})
subsetter.subset(font)
names = {1: "Virtual Desktop Fixture Sans", 2: "Regular", 3: "VirtualDesktopFixtureSans-Regular-1", 4: "Virtual Desktop Fixture Sans Regular", 6: "VirtualDesktopFixtureSans-Regular", 16: "Virtual Desktop Fixture Sans", 17: "Regular"}
for record in font["name"].names:
    if record.nameID in names:
        record.string = names[record.nameID].encode(record.getEncoding())
font.save(root / "fixture-sans.otf")
output = (root / "fixture-sans.otf").read_bytes()
print(f"{len(output)} bytes, sha256={hashlib.sha256(output).hexdigest()}")
