"""Read system font tables through the same CoreText API used by pinned Skia.

This estimates the complete SFNT stream, not an oversized frame's emitted bytes.
No font data is saved. Font names come from the synthetic CDP diagnostic report.
"""
import argparse
import ctypes as c
import json
from pathlib import Path


def inspect_fonts(names):
    cf = c.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
    ct = c.CDLL('/System/Library/Frameworks/CoreText.framework/CoreText')
    cg = c.CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')

    def bind(lib, name, result, *args):
        fn = getattr(lib, name); fn.restype = result; fn.argtypes = list(args); return fn

    release = bind(cf, 'CFRelease', None, c.c_void_p)
    make_string = bind(cf, 'CFStringCreateWithCString', c.c_void_p, c.c_void_p, c.c_char_p, c.c_uint32)
    string_length = bind(cf, 'CFStringGetLength', c.c_long, c.c_void_p)
    string_bytes = bind(cf, 'CFStringGetCString', c.c_bool, c.c_void_p, c.c_char_p, c.c_long, c.c_uint32)
    array_length = bind(cf, 'CFArrayGetCount', c.c_long, c.c_void_p)
    array_value = bind(cf, 'CFArrayGetValueAtIndex', c.c_void_p, c.c_void_p, c.c_long)
    data_length = bind(cf, 'CFDataGetLength', c.c_long, c.c_void_p)
    make_font = bind(ct, 'CTFontCreateWithName', c.c_void_p, c.c_void_p, c.c_double, c.c_void_p)
    make_ui_font = bind(ct, 'CTFontCreateUIFontForLanguage', c.c_void_p, c.c_uint32, c.c_double, c.c_void_p)
    class Range(c.Structure):
        _fields_ = [('location', c.c_long), ('length', c.c_long)]
    fallback_font = bind(ct, 'CTFontCreateForString', c.c_void_p, c.c_void_p, c.c_void_p, Range)
    ps_name = bind(ct, 'CTFontCopyPostScriptName', c.c_void_p, c.c_void_p)
    glyph_count = bind(ct, 'CTFontGetGlyphCount', c.c_long, c.c_void_p)
    font_tables = bind(ct, 'CTFontCopyAvailableTables', c.c_void_p, c.c_void_p, c.c_uint32)
    font_table = bind(ct, 'CTFontCopyTable', c.c_void_p, c.c_void_p, c.c_uint32, c.c_uint32)
    graphics_font = bind(ct, 'CTFontCopyGraphicsFont', c.c_void_p, c.c_void_p, c.c_void_p)
    graphics_table = bind(cg, 'CGFontCopyTableForTag', c.c_void_p, c.c_void_p, c.c_uint32)
    results = []
    for name in sorted(names):
        if name.startswith('.'):
            base = make_ui_font(2, 16, None)  # kCTFontUIFontSystem; private names cannot use CreateWithName.
            sample = '中文字体记录测试' if 'PingFang' in name else 'اختبار الخط العربي' if 'Arabic' in name else None
            if sample:
                value = make_string(None, sample.encode(), 0x08000100)
                font = fallback_font(base, value, Range(0, len(sample.encode('utf-16-le')) // 2)); release(value); release(base)
            else:
                font = base
        else:
            value = make_string(None, name.encode(), 0x08000100)
            font = make_font(value, 16, None); release(value)
        actual = ps_name(font); buffer = c.create_string_buffer(string_length(actual) * 4 + 1)
        string_bytes(actual, buffer, len(buffer), 0x08000100); release(actual)
        result = {'requestedPostScriptName': name, 'actualPostScriptName': buffer.value.decode(), 'glyphs': glyph_count(font), 'tables': []}
        result['exactNameMatch'] = result['actualPostScriptName'] == name
        tags = font_tables(font, 0); graphics = graphics_font(font, None)
        for i in range(array_length(tags)):
            tag = array_value(tags, i)
            data = font_table(font, tag, 0) or graphics_table(graphics, tag)
            result['tables'].append({'tag': int(tag).to_bytes(4, 'big').decode('latin1'), 'bytes': data_length(data) if data else None})
            if data: release(data)
        release(tags); release(graphics); release(font)
        if result['exactNameMatch'] and all(table['bytes'] is not None for table in result['tables']):
            result['estimatedSfntBytes'] = 12 + len(result['tables']) * 16 + sum((table['bytes'] + 3) & ~3 for table in result['tables'])
            result['estimatedBase64Bytes'] = 4 * ((result['estimatedSfntBytes'] + 2) // 3)
        results.append(result)
    return results


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True); parser.add_argument('--output', required=True)
    args = parser.parse_args()
    source = json.loads(Path(args.input).read_text())
    names = {font['postScriptName'] for case in source['cases'] for font in case.get('platformFonts', []) if not font['isCustomFont']}
    report = {'scope': __doc__, 'fonts': inspect_fonts(names)}
    Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps([{k:font[k] for k in ('requestedPostScriptName', 'exactNameMatch', 'glyphs', 'estimatedSfntBytes', 'estimatedBase64Bytes') if k in font} for font in report['fonts']], ensure_ascii=False))
