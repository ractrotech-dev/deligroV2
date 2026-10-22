/// "32 min", "1 h 5 min", "2 h"; "—" for an unknown length.
String minutesText(num? minutes) {
  if (minutes == null || minutes.isNaN) return '—';
  final m = minutes.round();
  if (m < 60) return '$m min';
  final h = m ~/ 60;
  final r = m % 60;
  return r == 0 ? '$h h' : '$h h $r min';
}

/// "62.5%", "25%"; "—" when there is nothing to divide (never 0% or 100%).
String percentText(num? percent) {
  if (percent == null || percent.isNaN) return '—';
  final t = percent.toStringAsFixed(1);
  return '${t.endsWith('.0') ? t.substring(0, t.length - 2) : t}%';
}

/// "8 h", "8.5 h".
String hoursText(num hours) {
  final t = hours.toStringAsFixed(1);
  return '${t.endsWith('.0') ? t.substring(0, t.length - 2) : t} h';
}
