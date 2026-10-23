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

String distance(double km) =>
    km < 1 ? '${(km * 1000).round()} m' : '${km.toStringAsFixed(km < 10 ? 1 : 0)} km';
