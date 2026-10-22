// The server offset: what the board's clock does to "now" for offers and the
// unreachable wait, and the limit on how far it is allowed to move it.
import 'package:deligro_rider/state/clock.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late ProviderContainer c;
  late DateTime phone;

  setUp(() {
    phone = DateTime.utc(2026, 10, 22, 10);
    c = ProviderContainer(overrides: [clockProvider.overrideWithValue(() => phone)]);
    addTearDown(c.dispose);
  });

  test('the server clock is the phone clock until a board has said otherwise', () {
    expect(c.read(serverClockProvider)(), phone);
  });

  test('an offset moves the server clock, and follows the phone clock', () {
    c.read(serverOffsetProvider.notifier).set(const Duration(minutes: -3));
    expect(c.read(serverClockProvider)(), phone.subtract(const Duration(minutes: 3)));
    phone = phone.add(const Duration(seconds: 10));
    expect(c.read(serverClockProvider)(), DateTime.utc(2026, 10, 22, 10, 0, 10).subtract(const Duration(minutes: 3)));
  });

  test('an offset beyond 24 hours is ignored and the previous one stays', () {
    final offset = c.read(serverOffsetProvider.notifier);
    offset.set(const Duration(minutes: 3));
    offset.set(const Duration(hours: 24, seconds: 1));
    expect(c.read(serverOffsetProvider), const Duration(minutes: 3));
    offset.set(const Duration(days: -400));
    expect(c.read(serverOffsetProvider), const Duration(minutes: 3));
  });

  test('exactly 24 hours either way is still accepted', () {
    final offset = c.read(serverOffsetProvider.notifier);
    offset.set(const Duration(hours: 24));
    expect(c.read(serverOffsetProvider), const Duration(hours: 24));
    offset.set(const Duration(hours: -24));
    expect(c.read(serverOffsetProvider), const Duration(hours: -24));
  });
}
