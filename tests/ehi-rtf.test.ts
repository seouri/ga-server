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

describe('rtfToText fix round 1', () => {
  it('a line break between \\uN and its fallback is not text and does not end the fallback; a control word counts as one', () => {
    expect(rtfToText('{\\rtf1 a\\u8217\r\n?b}')).toBe('a\u2019b');
    expect(rtfToText('{\\rtf1\\uc2 a\\u8217\\i ?b}')).toBe('a\u2019b'); // \i is the first fallback char, ? the second
  });

  it('\\upr: the Unicode \\ud copy only, once', () => {
    expect(rtfToText('{\\rtf1 {\\upr{x?}{\\*\\ud{x\\u20013?}}}}')).toBe('x\u4E2D');
  });

  it('honours \\ansicpg and a font\'s \\fcharset for hex escapes', () => {
    expect(rtfToText("{\\rtf1\\ansi\\ansicpg1251 \\'cf}")).toBe('\u041F'); // П
    // 0xC7D1 is 한 in EUC-KR; font 1 declares charset 129, font 0 the document's 1252.
    expect(rtfToText("{\\rtf1\\ansi\\ansicpg1252{\\fonttbl{\\f0\\fswiss\\fcharset0 Arial;}{\\f1\\fnil\\fcharset129 Gulim;}}\\f1 \\'c7\\'d1\\f0  \\'e9}")).toBe('\uD55C \u00E9');
  });

  it('skips \\binN payload bytes', () => {
    expect(rtfToText('{\\rtf1 a{\\pict\\bin4 {}\\x}b}')).toBe('ab');
    expect(rtfToText('{\\rtf1 a\\bin3 xyzb}')).toBe('ab');
  });
});
