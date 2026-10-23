// A throwaway app for checking FLAG_SECURE on a device with no backend.
//
// It reaches the same MainActivity and the same `deligro/secure` channel as the real app
// and shows a block of fake "secret" text. After 3 s it turns the flag ON; after 25 s it
// turns it OFF. In between, a screenshot taken over adb is black and the recent-apps
// thumbnail is blank; before and after, they show the text.
//
//   flutter build apk --release -t tool/secure_probe.dart
//   adb install -r build/app/outputs/flutter-apk/app-release.apk
//   adb shell am start -n com.ractrotech.deligro.manager/.MainActivity
//   adb shell dumpsys window windows | grep -i SECURE        (between 3 s and 25 s: shows the flag)
//   adb exec-out screencap -p > secure.png                    (black while the flag is on)
//
// Not part of the shipped app: nothing imports this file.
import 'dart:async';

import 'package:flutter/material.dart';

import 'package:deligro_manager/core/secure_screens.dart';

void main() {
  runApp(const _Probe());
}

class _Probe extends StatefulWidget {
  const _Probe();

  @override
  State<_Probe> createState() => _ProbeState();
}

class _ProbeState extends State<_Probe> {
  static const _channel = MethodSecureChannel();
  String _state = 'flag OFF';
  final _timers = <Timer>[];

  @override
  void initState() {
    super.initState();
    _timers.add(Timer(const Duration(seconds: 3), () {
      _channel.setSecure(true);
      setState(() => _state = 'flag ON');
    }));
    _timers.add(Timer(const Duration(seconds: 25), () {
      _channel.setSecure(false);
      setState(() => _state = 'flag OFF');
    }));
  }

  @override
  void dispose() {
    for (final t in _timers) {
      t.cancel();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      home: Scaffold(
        backgroundColor: Colors.white,
        body: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text('SECRET  Total sales 12,34,567', style: TextStyle(fontSize: 26, color: Colors.black)),
              const SizedBox(height: 12),
              const Text('Customer +91 98765 43210', style: TextStyle(fontSize: 22, color: Colors.black)),
              const SizedBox(height: 28),
              Text(_state, style: const TextStyle(fontSize: 30, fontWeight: FontWeight.bold, color: Colors.red)),
            ],
          ),
        ),
      ),
    );
  }
}
