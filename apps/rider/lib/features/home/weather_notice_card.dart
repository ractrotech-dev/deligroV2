import 'package:flutter/material.dart';

import '../../models/dashboard.dart';
import '../../theme/app_theme.dart';

/// Rain or a storm in the rider's zone (0178): ride carefully; customers have
/// been told to expect delays.
class WeatherNoticeCard extends StatelessWidget {
  const WeatherNoticeCard({super.key, required this.notice});
  final WeatherNotice notice;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Container(
        key: Key('weather-notice-${notice.level}'),
        padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
        decoration: BoxDecoration(color: c.pop, borderRadius: BorderRadius.circular(radiusBlock)),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(notice.level == 'heat' ? Icons.wb_sunny_outlined : Icons.thunderstorm_outlined, color: c.popInk),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(notice.title, style: TextStyle(color: c.popInk, fontWeight: FontWeight.w800)),
                  const SizedBox(height: 2),
                  Text(notice.body, style: TextStyle(color: c.popInk, height: 1.3)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
