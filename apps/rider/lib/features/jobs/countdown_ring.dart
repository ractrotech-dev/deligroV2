import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../theme/app_theme.dart';

/// "2:59": whole seconds left, rounded up so 0:00 means the time is over.
String formatCountdown(Duration left) {
  final ms = left.inMilliseconds;
  final seconds = ms <= 0 ? 0 : (ms / 1000).ceil();
  return '${seconds ~/ 60}:${(seconds % 60).toString().padLeft(2, '0')}';
}

/// A ring that empties as the exclusive window runs out, with the time left in
/// the middle. Green, then red in the last 30 seconds; the number carries the
/// meaning, colour only backs it up.
class CountdownRing extends StatelessWidget {
  const CountdownRing({super.key, required this.left, required this.total, this.size = 68});

  final Duration left;
  final Duration total;
  final double size;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final fraction = total.inMilliseconds <= 0
        ? 0.0
        : (left.inMilliseconds / total.inMilliseconds).clamp(0.0, 1.0);
    final urgent = left.inSeconds < 30;
    final text = formatCountdown(left);
    final minutes = left.inSeconds ~/ 60;
    return Semantics(
      label: 'Time left to accept: $minutes minutes ${left.inSeconds % 60} seconds',
      excludeSemantics: true,
      child: SizedBox(
        width: size,
        height: size,
        child: CustomPaint(
          painter: _RingPainter(
            fraction: fraction,
            track: c.line,
            color: urgent ? c.deal : c.green,
          ),
          child: Center(
            child: Padding(
              padding: const EdgeInsets.all(10),
              child: FittedBox(
                fit: BoxFit.scaleDown,
                child: Text(
                  text,
                  maxLines: 1,
                  style: dataStyle(context, size: 16, weight: FontWeight.w800)
                      .copyWith(color: urgent ? c.deal : c.ink),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _RingPainter extends CustomPainter {
  _RingPainter({required this.fraction, required this.track, required this.color});

  final double fraction;
  final Color track;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    const stroke = 6.0;
    final rect = Offset.zero & size;
    final arc = rect.deflate(stroke / 2);
    final paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..strokeCap = StrokeCap.round;
    canvas.drawArc(arc, 0, math.pi * 2, false, paint..color = track);
    if (fraction > 0) {
      canvas.drawArc(arc, -math.pi / 2, math.pi * 2 * fraction, false, paint..color = color);
    }
  }

  @override
  bool shouldRepaint(_RingPainter old) =>
      old.fraction != fraction || old.track != track || old.color != color;
}
