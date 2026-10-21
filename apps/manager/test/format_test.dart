import 'package:deligro_manager/core/format.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test("today is India's date whatever the phone's own time zone says", () {
    expect(istToday(DateTime.utc(2026, 10, 21, 19, 0)), DateTime(2026, 10, 22)); // 00:30 IST on the 22nd
    expect(istToday(DateTime.utc(2026, 10, 21, 18, 29)), DateTime(2026, 10, 21)); // 23:59 IST on the 21st
  });
}
