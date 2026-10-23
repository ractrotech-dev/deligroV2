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

    // ...then shows for 1.45 s and fades. The decode is real I/O and lands
    // when it lands, so poll in small real-time steps rather than one fixed
    // wait, moving the fake clock on between them.
    final watch = Stopwatch()..start();
    while (tester.widget<AnimatedOpacity>(find.byType(AnimatedOpacity)).opacity > 0) {
      if (watch.elapsed > const Duration(seconds: 15)) fail('the splash never started to fade');
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
      await tester.pump(const Duration(milliseconds: 100));
    }
    await tester.pumpAndSettle();

    expect(find.byType(SplashArt), findsNothing);
    expect(find.text('first screen'), findsOneWidget);
  });
}
