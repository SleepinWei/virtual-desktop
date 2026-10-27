# Fixture font

`fixture-sans.otf` is a renamed subset of Noto Sans CJK SC Regular, licensed under the [SIL Open Font License 1.1](OFL.txt). It retains the source copyright and license metadata. This modified font is named **Virtual Desktop Fixture Sans**, and is used only by the trusted rendering fixture.

- Source repository revision: `f8d157532fbfaeda587e826d4cd5b21a49186f7c`
- [Original font](https://raw.githubusercontent.com/notofonts/noto-cjk/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf): 16,437,364 bytes, SHA-256 `2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b`
- [Original license](https://raw.githubusercontent.com/notofonts/noto-cjk/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/LICENSE)
- Subset: 21,232 bytes, SHA-256 `c52e024b0e36b06ccf319a934862675adbbdc1aac76e66cb60fb718f05426637`

Rebuild using Python and `fonttools==4.60.2`, with the original font downloaded separately:

```bash
python build-subset.py /path/to/NotoSansCJKsc-Regular.otf
```

The script checks the original SHA-256, retains ASCII and all non-ASCII characters in the fixture HTML/JS/CSS, preserves copyright/license name records and renames the modified font. No font tool is needed to run the experiment. Adding new fixture text may require rebuilding the subset and updating its checksum.

The small fixture font bounds the native picture serialization test. It does not establish a general resource/subsetting protocol for arbitrary websites or prove large system fonts can be transported without trace loss.
