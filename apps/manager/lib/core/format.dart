import 'package:intl/intl.dart';

final _inr = NumberFormat.decimalPattern('en_IN');

/// ₹1,23,456 — whole rupees, Indian grouping (formatINR on the web).
String rupees(num amount) => '₹${_inr.format(amount.round())}';

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
  final date = DateFormat(local.year == now.year ? 'd MMM' : 'd MMM y').format(local);
  return '$date, $time';
}

/// "12 min late", "3 h late", "2 days late".
String lateness(int minutes) {
  final m = minutes < 0 ? 0 : minutes;
  if (m < 60) return '$m min late';
  if (m < 60 * 24) return '${(m / 60).round()} h late';
  final d = (m / (60 * 24)).round();
  return '$d ${d == 1 ? 'day' : 'days'} late';
}

String etaBand(int min, int max) => min == max ? '$min min' : '$min–$max min';

String distance(double km) =>
    km < 1 ? '${(km * 1000).round()} m' : '${km.toStringAsFixed(km < 10 ? 1 : 0)} km';

/// 1,23,456 — a count in Indian grouping.
String count(num n) => _inr.format(n.round());

/// Today's date in India (IST, UTC+5:30), as a local date with no time. The
/// business — and the server's "today", and every range limit it checks —
/// runs on India time whatever the phone's own time zone is set to.
DateTime istToday([DateTime? now]) {
  final ist = (now ?? DateTime.now()).toUtc().add(const Duration(hours: 5, minutes: 30));
  return DateTime(ist.year, ist.month, ist.day);
}
