import 'package:intl/intl.dart';

final _whole = NumberFormat.decimalPatternDigits(
  locale: 'en_IN',
  decimalDigits: 0,
);
final _paise = NumberFormat.decimalPatternDigits(
  locale: 'en_IN',
  decimalDigits: 2,
);

/// A real minus sign (U+2212), as on the website's statements.
const minus = '−';

/// ₹120, ₹1,23,456 or ₹37.50: whole rupees stay whole, a rider's pay can have
/// paise so they are never rounded away. A negative amount is "−₹120".
String money(num amount) {
  final p = (amount * 100).round();
  final abs = p.abs();
  final text = abs % 100 == 0
      ? _whole.format(abs ~/ 100)
      : _paise.format(abs / 100);
  return '${p < 0 ? minus : ''}₹$text';
}

/// [money] with a "+" on a positive amount (an adjustment, a record in a list).
String signedMoney(num amount) =>
    (amount * 100).round() > 0 ? '+${money(amount)}' : money(amount);

/// A plain decimal for a spreadsheet: `-20.00`, `1234.50`. No symbol, no grouping.
String plainAmount(num amount) =>
    ((amount * 100).round() / 100).toStringAsFixed(2);

final _dayFmt = DateFormat('d MMM y');
final _dayShortFmt = DateFormat('d MMM');

DateTime? parseDay(String? key) {
  if (key == null) return null;
  final m = RegExp(r'^(\d{4})-(\d{2})-(\d{2})').firstMatch(key);
  if (m == null) return null;
  return DateTime(int.parse(m[1]!), int.parse(m[2]!), int.parse(m[3]!));
}

/// "21 Oct 2026" for a `YYYY-MM-DD` key; the key itself when it is not one.
String formatDay(String? key, {bool year = true}) {
  final d = parseDay(key);
  if (d == null) return key ?? '';
  return (year ? _dayFmt : _dayShortFmt).format(d);
}

/// The IST calendar day (`YYYY-MM-DD`) of an instant: the day the server cuts
/// today, the week and the month on.
String istDayKey(DateTime at) {
  final ist = at.toUtc().add(const Duration(hours: 5, minutes: 30));
  return '${ist.year.toString().padLeft(4, '0')}-${ist.month.toString().padLeft(2, '0')}-${ist.day.toString().padLeft(2, '0')}';
}

/// A day key as a `DateTime` (local midnight) and back.
String dayKeyOf(DateTime d) =>
    '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

String addDays(String key, int n) {
  final d = parseDay(key)!;
  return dayKeyOf(DateTime(d.year, d.month, d.day + n));
}

/// "21 Oct 2026 – 28 Oct 2026", or one day alone.
String formatRange(String from, String to) =>
    from == to ? formatDay(from) : '${formatDay(from)} – ${formatDay(to)}';
