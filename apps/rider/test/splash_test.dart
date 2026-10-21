import 'package:deligro_rider/widgets/splash.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('splash covers the app, then fades out and is removed', (tester) async {
    await tester.pumpWidget(const MaterialApp(
      home: SplashOverlay(child: Text('first screen')),
    ));

    expect(find.byType(SplashArt), findsOneWidget);
    expect(find.text('Phoxera Solutions Private Limited'), findsOneWidget);
    expect(find.text('RIDER'), findsOneWidget);
    expect(find.text('first screen'), findsOneWidget); // loads underneath

    // Holds until the artwork has decoded (real I/O, outside fake time)...
    await tester.pump(const Duration(seconds: 3));
    expect(find.byType(SplashArt), findsOneWidget);
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 500)));

    // ...then shows for 1.45 s and fades.
    await tester.pump(const Duration(milliseconds: 1450));
    await tester.pumpAndSettle();

    expect(find.byType(SplashArt), findsNothing);
    expect(find.text('first screen'), findsOneWidget);
  });
}
