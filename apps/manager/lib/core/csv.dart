/// CSV for every report the app exports, so each one inherits the same two
/// protections.
///
/// * **Formula injection.** A vendor name, category or cancellation reason is
///   typed by someone outside Deligro. A cell starting with `=`, `+`, `-`, `@`,
///   a tab or a carriage return is run as a formula by Excel and Sheets, so
///   text cells that start that way get a leading apostrophe (OWASP's advice).
///   Numbers are written as numbers — a negative balance stays `-250`.
/// * **Encoding.** The file starts with a UTF-8 byte-order mark; without it
///   Excel on Windows opens ₹ as mojibake.
library;

final _formulaStart = RegExp(r'^[=+\-@\t\r]');
final _needsQuotes = RegExp(r'[",\n\r]');

String csvCell(Object? v) {
  if (v == null) return '';
  if (v is num) return '$v';
  var s = '$v';
  if (_formulaStart.hasMatch(s)) s = "'$s";
  return _needsQuotes.hasMatch(s) ? '"${s.replaceAll('"', '""')}"' : s;
}

String csvRow(List<Object?> row) => row.map(csvCell).join(',');

/// The lines as one file: BOM first, a newline after the last line.
String csvDocument(List<String> lines) => '\uFEFF${lines.join('\n')}\n';
