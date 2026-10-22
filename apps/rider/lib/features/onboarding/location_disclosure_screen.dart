import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/location_service.dart';
import '../../state/prefs.dart';
import '../../theme/app_theme.dart';

/// Where the disclosure lives. Going online pushes it and waits for a bool
/// (true = Continue); Settings opens it with `?read=1`, to read only.
const locationDisclosurePath = '/location-disclosure';
const locationDisclosureReadPath = '$locationDisclosurePath?read=1';

final locationDisclosureRoute = GoRoute(
  path: locationDisclosurePath,
  builder: (_, state) => LocationDisclosureScreen(
    decision: state.uri.queryParameters['read'] != '1',
  ),
);

class _Point {
  const _Point(this.icon, this.title, this.body);

  final IconData icon;
  final String title;
  final String body;
}

const _points = <_Point>[
  _Point(
    Icons.my_location_rounded,
    'What we collect',
    "Your phone's precise location (GPS).",
  ),
  _Point(
    Icons.schedule_rounded,
    'When',
    'Only while you are online, including when the app is closed or your '
        'screen is locked. A notification shows while it is on. Nothing is '
        'collected when you are offline.',
  ),
  _Point(
    Icons.local_offer_outlined,
    'Why',
    'To show you offers near you, and to give your customer live tracking '
        'while you bring their order.',
  ),
  _Point(
    Icons.visibility_outlined,
    'Who sees it',
    'Deligro ops. The customer sees where you are only while you carry '
        'their order.',
  ),
  _Point(
    Icons.power_settings_new_rounded,
    'How to stop',
    'Go offline. Sharing stops at once.',
  ),
];

/// The prominent disclosure Google Play asks for before the app reads
/// location: what, when, why, who and how to stop, in plain words, shown before
/// the system permission prompt. [decision] is the going-online version
/// (Continue / Not now); without it the screen is just there to read.
class LocationDisclosureScreen extends ConsumerWidget {
  const LocationDisclosureScreen({super.key, this.decision = true});

  final bool decision;

  Future<void> _continue(BuildContext context, WidgetRef ref) async {
    await ref.read(prefsProvider).setBool(locationDisclosureKey, true);
    if (context.mounted) context.pop(true);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    return Scaffold(
      appBar: AppBar(title: const Text('Your location')),
      body: SafeArea(
        child: Column(
          children: [
            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(20, 4, 20, 16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Deligro Rider uses your location to send you orders',
                      style: Theme.of(context).textTheme.headlineSmall,
                    ),
                    const SizedBox(height: 18),
                    for (final p in _points) ...[
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Container(
                            width: 40,
                            height: 40,
                            decoration: BoxDecoration(
                              color: c.accentSoft,
                              borderRadius: BorderRadius.circular(12),
                            ),
                            child: Icon(p.icon, color: c.accentInk, size: 22),
                          ),
                          const SizedBox(width: 14),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  p.title,
                                  style: Theme.of(context).textTheme.titleMedium,
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  p.body,
                                  style: TextStyle(
                                    color: c.muted,
                                    fontSize: 15,
                                    height: 1.4,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 18),
                    ],
                  ],
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: decision
                    ? [
                        FilledButton(
                          key: const Key('disclosure-continue'),
                          onPressed: () => _continue(context, ref),
                          child: const Text('Continue'),
                        ),
                        const SizedBox(height: 8),
                        TextButton(
                          key: const Key('disclosure-not-now'),
                          onPressed: () => context.pop(false),
                          style: TextButton.styleFrom(
                            minimumSize: const Size.fromHeight(48),
                          ),
                          child: const Text('Not now'),
                        ),
                      ]
                    : [
                        OutlinedButton(
                          key: const Key('disclosure-close'),
                          onPressed: () => context.pop(),
                          child: const Text('Close'),
                        ),
                      ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
