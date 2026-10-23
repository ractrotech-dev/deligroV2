// The proof-photo step tells the rider what to photograph before the camera
// opens (ruling P8-R4, §7.5 privacy safeguard): the package at the door, never
// a person. The line goes once a photo is taken.

import 'dart:io';

import 'package:deligro_rider/features/delivery/proof_photo.dart';
import 'package:deligro_rider/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Future<void> _pump(
  WidgetTester tester,
  Widget tile, {
  Brightness brightness = Brightness.light,
  double scale = 1.0,
}) async {
  tester.view.physicalSize = const Size(720, 1440);
  tester.view.devicePixelRatio = 2;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(
    theme: buildTheme(brightness),
    home: MediaQuery(
      data: MediaQueryData(size: const Size(360, 720), textScaler: TextScaler.linear(scale)),
      child: Scaffold(body: Padding(padding: const EdgeInsets.all(16), child: tile)),
    ),
  ));
  await tester.pump();
}

void main() {
  testWidgets('before the photo: the button and one line saying photograph the package, not people', (tester) async {
    var taps = 0;
    await _pump(tester, ProofPhotoTile(state: ProofState.none, photo: null, onTake: () => taps++));
    expect(find.byKey(const Key('proof-photo')), findsOneWidget);
    expect(find.byKey(const Key('proof-photo-hint')), findsOneWidget);
    expect(find.text('Photograph the package at the door — not people.'), findsOneWidget);
    await tester.tap(find.byKey(const Key('proof-photo')));
    expect(taps, 1, reason: 'the button still opens the camera');
  });

  testWidgets('once a photo is attached the hint is gone', (tester) async {
    await _pump(
      tester,
      ProofPhotoTile(state: ProofState.attached, photo: File('missing.jpg'), onTake: () {}),
    );
    expect(find.byKey(const Key('proof-photo-attached')), findsOneWidget);
    expect(find.byKey(const Key('proof-photo-hint')), findsNothing);
  });

  for (final dark in [false, true]) {
    testWidgets('the hint fits at 1.3x text in ${dark ? 'dark' : 'light'}', (tester) async {
      await _pump(
        tester,
        ProofPhotoTile(state: ProofState.none, photo: null, onTake: () {}),
        brightness: dark ? Brightness.dark : Brightness.light,
        scale: 1.3,
      );
      expect(tester.takeException(), isNull);
      expect(find.byKey(const Key('proof-photo-hint')), findsOneWidget);
    });
  }
}
