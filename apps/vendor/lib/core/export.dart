import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';

/// A table to download: one header row and rows of cells. Numbers stay
/// numbers so a spreadsheet can add them up.
class ExportTable {
  const ExportTable({required this.title, required this.headers, required this.rows});

  final String title;
  final List<String> headers;

  /// Each cell is a String, a num, or null (empty).
  final List<List<Object?>> rows;
}

String _csvCell(Object? v) {
  if (v == null) return '';
  final s = '$v';
  // Quote anything that could break a row, and anything a spreadsheet would
  // read as a formula (=, +, -, @ at the start).
  final risky = RegExp(r'[",\r\n]').hasMatch(s) || (v is String && RegExp(r'^[=+\-@]').hasMatch(s));
  final safe = v is String && RegExp(r'^[=+\-@]').hasMatch(s) ? "'$s" : s;
  return risky ? '"${safe.replaceAll('"', '""')}"' : safe;
}

/// UTF-8 CSV with a BOM, so Excel opens ₹ and names correctly.
Uint8List toCsv(ExportTable t) {
  final b = StringBuffer('﻿');
  b.writeln(t.headers.map(_csvCell).join(','));
  for (final r in t.rows) {
    b.writeln(r.map(_csvCell).join(','));
  }
  return Uint8List.fromList(utf8.encode(b.toString()));
}

String _xml(String s) => s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll(RegExp(r'[\x00-\x08\x0B\x0C\x0E-\x1F]'), '');

String _col(int i) {
  var n = i + 1, s = '';
  while (n > 0) {
    final r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = (n - 1) ~/ 26;
  }
  return s;
}

/// A minimal .xlsx (Office Open XML): one sheet, a bold header row, inline
/// strings and real numbers. Built by hand because the `excel` package
/// conflicts with `pdf`'s xml dependency.
Uint8List toXlsx(ExportTable t) {
  String cell(int r, int c, Object? v, {bool header = false}) {
    final ref = '${_col(c)}${r + 1}';
    final style = header ? ' s="1"' : '';
    if (v == null) return '<c r="$ref"$style/>';
    if (v is num) return '<c r="$ref"$style><v>$v</v></c>';
    return '<c r="$ref"$style t="inlineStr"><is><t xml:space="preserve">${_xml('$v')}</t></is></c>';
  }

  final sheet = StringBuffer(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>',
  );
  sheet.write('<row r="1">');
  for (var c = 0; c < t.headers.length; c++) {
    sheet.write(cell(0, c, t.headers[c], header: true));
  }
  sheet.write('</row>');
  for (var r = 0; r < t.rows.length; r++) {
    sheet.write('<row r="${r + 2}">');
    for (var c = 0; c < t.rows[r].length; c++) {
      sheet.write(cell(r + 1, c, t.rows[r][c]));
    }
    sheet.write('</row>');
  }
  sheet.write('</sheetData></worksheet>');

  final name = _xml(t.title.length > 31 ? t.title.substring(0, 31) : t.title).replaceAll(RegExp(r'[\\/?*\[\]:]'), ' ');
  final files = <String, String>{
    '[Content_Types].xml':
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        '</Types>',
    '_rels/.rels':
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        '</Relationships>',
    'xl/workbook.xml':
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheets><sheet name="$name" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        '</Relationships>',
    'xl/styles.xml':
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
        '</styleSheet>',
    'xl/worksheets/sheet1.xml': sheet.toString(),
  };
  final archive = Archive();
  files.forEach((path, content) => archive.add(ArchiveFile.string(path, content)));
  return ZipEncoder().encodeBytes(archive);
}

/// "Sales report 1-21 Oct" → "sales-report-1-21-oct".
String fileSlug(String s) => s.toLowerCase().replaceAll(RegExp(r'[^a-z0-9]+'), '-').replaceAll(RegExp(r'^-|-$'), '');

/// Writes [bytes] to a temporary file and opens the share sheet.
Future<void> shareBytes(Uint8List bytes, String fileName, String mimeType, {String? subject}) async {
  final dir = await getTemporaryDirectory();
  final file = File('${dir.path}/$fileName');
  await file.writeAsBytes(bytes, flush: true);
  await SharePlus.instance.share(
    ShareParams(
      files: [XFile(file.path, mimeType: mimeType)],
      subject: subject ?? fileName,
    ),
  );
}

const csvMime = 'text/csv';
const xlsxMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const pdfMime = 'application/pdf';
