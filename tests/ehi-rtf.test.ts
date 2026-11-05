import { describe, expect, it } from 'vitest';
import { rtfToText } from '../src/ehi/rtf.ts';

describe('rtfToText', () => {
  it('rtf text keeps unicode and drops control groups', () => {
    const rtf =
      "{\\rtf1\\ansi\\ansicpg1252{\\fonttbl{\\f0\\fswiss Arial;}}{\\colortbl;\\red0\\green0\\blue0;}{\\*\\generator Riched20;}" +
      "\\uc1\\pard\\f0\\fs20 Caf\\'e9 \\u20013?\\u25991?\\par" +
      '{\\b Bold}\\tab x\\line y \\{braces\\} back\\\\slash ' +
      '{\\*\\bkmkstart a}{\\field{\\*\\fldinst HYPERLINK "u"}{\\fldrslt link}}\\par}';
    expect(rtfToText(rtf)).toBe('Café 中文\nBold\tx\ny {braces} back\\slash link');
  });

  it('a unicode escape skips its fallback, including a hex fallback; surrogate pairs join', () => {
    expect(rtfToText("{\\rtf1 a\\u8217\\'92b \\u-10179?\\u-8704?}")).toBe('a’b \u{1F600}');
  });

  it('pictures and bare line breaks in the source are dropped', () => {
    expect(rtfToText('{\\rtf1 one\r\n two{\\pict\\jpegblip ffd8ff}{\\header H}}')).toBe('one two');
  });
});
