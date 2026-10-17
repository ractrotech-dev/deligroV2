import 'dart:convert';

import 'package:deligro_customer/core/pricing.dart';
import 'package:deligro_customer/core/session_cookie.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('session cookie', () {
    test('name is sb-<project-ref>-auth-token', () {
      expect(
        sessionCookieName('https://qbyvnnzvpehfwhutakxv.supabase.co'),
        'sb-qbyvnnzvpehfwhutakxv-auth-token',
      );
    });

    test('value is base64- + unpadded base64url of the JSON', () {
      final value = sessionCookieValue({'a': 'ü?>'});
      expect(value.startsWith('base64-'), isTrue);
      final body = value.substring(7);
      expect(body.contains('='), isFalse);
      expect(body.contains('+') || body.contains('/'), isFalse);
      final decoded = utf8.decode(base64Url.decode(base64Url.normalize(body)));
      expect(jsonDecode(decoded), {'a': 'ü?>'});
    });

    test('short values stay one cookie under the bare name', () {
      final chunks = chunkCookie('k', 'base64-abc');
      expect(chunks.map((c) => '${c.key}=${c.value}'), ['k=base64-abc']);
    });

    test('long values split into .0, .1 … of at most 3180 chars', () {
      final long = 'base64-${'A' * 7000}';
      final chunks = chunkCookie('k', long);
      expect(chunks.map((c) => c.key), ['k.0', 'k.1', 'k.2']);
      expect(chunks.every((c) => c.value.length <= 3180), isTrue);
      expect(chunks.map((c) => c.value).join(), long);
    });
  });

  group('charges (mirrors lib/pricing.ts computeChargesWith)', () {
    const config = ChargesConfig(
      deliveryFee: 29,
      taxRate: 0.05,
      freeDeliveryThreshold: 300,
    );

    test('fee, tax on items only, tip', () {
      final c = computeCharges(config, 200, tip: 20);
      expect(c.deliveryFee, 29);
      expect(c.taxes, 10);
      expect(c.total, 200 + 29 + 10 + 20);
    });

    test('free delivery at the threshold', () {
      expect(computeCharges(config, 300).deliveryFee, 0);
    });

    test('threshold 0 means never free', () {
      const never = ChargesConfig(
        deliveryFee: 29,
        taxRate: 0.05,
        freeDeliveryThreshold: 0,
      );
      expect(computeCharges(never, 5000).deliveryFee, 29);
    });

    test('empty basket costs nothing', () {
      expect(computeCharges(config, 0).total, 0);
    });

    test('tip is clamped to 0..50 and rounded', () {
      expect(computeCharges(config, 100, tip: 500).tip, 50);
      expect(computeCharges(config, 100, tip: -5).tip, 0);
      expect(computeCharges(config, 100, tip: 20.6).tip, 21);
    });

    test('discount comes off the total, floored at 0', () {
      expect(computeCharges(config, 100, discount: 1000).total, 0);
    });
  });

  group('effective price', () {
    test('discount wins only when lower and non-negative', () {
      expect(effectivePrice(100, 80), 80);
      expect(effectivePrice(100, 120), 100);
      expect(effectivePrice(100, null), 100);
      expect(effectivePrice(100, -1), 100);
    });
  });

  group('kitchen pace', () {
    final now = DateTime.utc(2026, 10, 17, 12);

    test('falls back and widens an inverted band', () {
      final p = kitchenPace(etaMin: 30, etaMax: 20, now: now);
      expect(p.etaMin, 30);
      expect(p.etaMax, 30);
      expect(p.busy, isFalse);
    });

    test('a live busy bump is added', () {
      final p = kitchenPace(
        etaMin: 20,
        etaMax: 30,
        busyUntil: now.add(const Duration(minutes: 10)),
        busyExtraMinutes: 15,
        now: now,
      );
      expect(p.etaMin, 35);
      expect(p.etaMax, 45);
      expect(p.busy, isTrue);
    });

    test('a lapsed bump is ignored', () {
      final p = kitchenPace(
        etaMin: 20,
        etaMax: 30,
        busyUntil: now.subtract(const Duration(minutes: 1)),
        busyExtraMinutes: 15,
        now: now,
      );
      expect(p.etaMin, 20);
      expect(p.busy, isFalse);
    });
  });
}
