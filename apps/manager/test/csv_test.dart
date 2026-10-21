import 'package:deligro_manager/core/csv.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('text that a spreadsheet would run as a formula is neutralised', () {
    for (final s in ['=HYPERLINK("x")', '+91 shop', '-2+3', '@SUM(A1)', '\tTab', '\rCR']) {
      expect(csvCell(s).replaceAll('"', '').startsWith("'"), isTrue, reason: s);
    }
  });

  test('numbers are numbers, negative ones included', () {
    expect(csvCell(-250), '-250');
    expect(csvCell(12.5), '12.5');
  });

  test('commas, quotes and line breaks are quoted', () {
    expect(csvCell('Tandoor, Bemetara'), '"Tandoor, Bemetara"');
    expect(csvCell('Say "hi"'), '"Say ""hi"""');
    expect(csvCell('a\nb'), '"a\nb"');
  });

  test('a document starts with a UTF-8 byte-order mark so ₹ and accents open correctly', () {
    final doc = csvDocument([csvRow(['Sales', '₹ 1,200'])]);
    expect(doc.codeUnitAt(0), 0xFEFF);
    expect(doc, endsWith('\n'));
  });
}
