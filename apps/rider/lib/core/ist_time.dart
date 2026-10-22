import 'package:intl/intl.dart';

/// The server cuts days, weeks and months in IST, so the app shows its times
/// in IST too, whatever the phone's zone says.
DateTime toIst(DateTime at) =>
    at.toUtc().add(const Duration(hours: 5, minutes: 30));

final _clock = DateFormat('h:mm a');
final _dayTime = DateFormat('d MMM, h:mm a');

/// "12:04 PM" in IST.
String istClock(DateTime at) => _clock.format(toIst(at));

/// "22 Oct, 12:04 PM" in IST.
String istDayTime(DateTime at) => _dayTime.format(toIst(at));
