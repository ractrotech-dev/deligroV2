import 'package:intl/intl.dart';

final _inr = NumberFormat.decimalPattern('en_IN');

/// ₹1,23,456 — whole rupees, Indian grouping (formatINR on the web).
String rupees(num amount) => '${amount < 0 ? '−' : ''}₹${_inr.format(amount.abs().round())}';

/// "Today, 8:24 PM" / "Yesterday, 1:05 PM" / "12 Oct, 7:40 PM".
String placedAt(DateTime? at) {
  if (at == null) return '';
  final local = at.toLocal();
  final now = DateTime.now();
  final day = DateTime(local.year, local.month, local.day);
  final today = DateTime(now.year, now.month, now.day);
  final time = DateFormat('h:mm a').format(local);
  final diff = today.difference(day).inDays;
  if (diff == 0) return 'Today, $time';
  if (diff == 1) return 'Yesterday, $time';
  final date = DateFormat(local.year == now.year ? 'd MMM' : 'd MMM y', 'en_IN').format(local);
  return '$date, $time';
}

/// "4 min", "1 h 5 min".
String minutesText(int minutes) {
  final m = minutes < 0 ? 0 : minutes;
  if (m < 60) return '$m min';
  final h = m ~/ 60, r = m % 60;
  final hours = '$h h';
  return r == 0 ? hours : '$hours $r min';
}

/// YYYY-MM-DD, as the website's date filters expect.
String isoDate(DateTime d) => DateFormat('yyyy-MM-dd').format(d);
