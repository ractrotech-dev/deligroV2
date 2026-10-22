import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../../theme/app_theme.dart';
import 'code_entry.dart';

/// What a scan gave back: the pickup code it read, `''` when the rider chose
/// to type the code instead, or null when they closed the scanner.
typedef QrScanner = Future<String?> Function(BuildContext context);

Future<String?> _openScanner(BuildContext context) => Navigator.of(context).push<String>(
      MaterialPageRoute(fullscreenDialog: true, builder: (_) => const QrScanScreen()),
    );

/// Tests replace it: there is no camera in a widget test.
final qrScannerProvider = Provider<QrScanner>((_) => _openScanner);

/// The pickup code in what a QR holds. The shop's QR (vendor board,
/// `PickupQr`) encodes the code itself and nothing else; a code with other
/// text around it is read for its digits, as the server reads a typed one.
String? pickupCodeFromQr(String? raw) {
  final digits = (raw ?? '').replaceAll(RegExp(r'\D'), '');
  return digits.length == codeLength ? digits : null;
}

/// Full-screen camera that reads the QR on the shop's order screen and hands
/// the code back. "Type the code instead" is always there: a cracked lens, a
/// dim screen or a denied camera permission must not stop a pickup.
class QrScanScreen extends StatefulWidget {
  const QrScanScreen({super.key});

  @override
  State<QrScanScreen> createState() => _QrScanScreenState();
}

class _QrScanScreenState extends State<QrScanScreen> {
  final _controller = MobileScannerController(
    detectionSpeed: DetectionSpeed.noDuplicates,
    formats: const [BarcodeFormat.qrCode],
  );
  bool _done = false;
  String? _notice;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _onDetect(BarcodeCapture capture) {
    if (_done) return;
    for (final b in capture.barcodes) {
      final code = pickupCodeFromQr(b.rawValue);
      if (code != null) {
        _done = true;
        Navigator.of(context).pop(code);
        return;
      }
    }
    if (capture.barcodes.isNotEmpty) {
      setState(() => _notice = "That isn't a Deligro pickup code. Scan the QR on the shop's order screen.");
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Scaffold(
      key: const Key('qr-scan-screen'),
      backgroundColor: Colors.black,
      body: Stack(
        fit: StackFit.expand,
        children: [
          MobileScanner(
            controller: _controller,
            onDetect: _onDetect,
            errorBuilder: (context, error) => _CameraProblem(error: error),
          ),
          // The frame to aim with.
          IgnorePointer(
            child: Center(
              child: Container(
                width: 250,
                height: 250,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(24),
                  border: Border.all(color: Colors.white, width: 4),
                ),
              ),
            ),
          ),
          SafeArea(
            child: Column(
              children: [
                // A dark band so the controls read over a bright camera view.
                Container(
                  margin: const EdgeInsets.fromLTRB(8, 8, 8, 0),
                  decoration: BoxDecoration(
                    color: Colors.black.withValues(alpha: .6),
                    borderRadius: BorderRadius.circular(radiusBlock),
                  ),
                  child: Row(
                    children: [
                      IconButton(
                        tooltip: 'Close',
                        onPressed: () => Navigator.of(context).pop(),
                        icon: const Icon(Icons.close_rounded, color: Colors.white, size: 30),
                      ),
                      const Expanded(
                        child: Text(
                          'Scan pickup QR',
                          style: TextStyle(color: Colors.white, fontSize: 19, fontWeight: FontWeight.w800),
                        ),
                      ),
                      ValueListenableBuilder(
                        valueListenable: _controller,
                        builder: (context, state, _) => IconButton(
                          tooltip: 'Torch',
                          onPressed: state.torchState == TorchState.unavailable ? null : _controller.toggleTorch,
                          icon: Icon(
                            state.torchState == TorchState.on ? Icons.flash_on_rounded : Icons.flash_off_rounded,
                            color: Colors.white,
                            size: 28,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
                const Spacer(),
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Container(
                        padding: const EdgeInsets.all(14),
                        decoration: BoxDecoration(
                          color: Colors.black.withValues(alpha: .65),
                          borderRadius: BorderRadius.circular(radiusBlock),
                        ),
                        child: Text(
                          _notice ?? "Point at the QR code on the shop's order screen.",
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            color: _notice == null ? Colors.white : c.pop,
                            fontSize: 16,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ),
                      const SizedBox(height: 12),
                      FilledButton.icon(
                        key: const Key('qr-type-instead'),
                        onPressed: () => Navigator.of(context).pop(''),
                        style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(56)),
                        icon: const Icon(Icons.dialpad_rounded),
                        label: const Text('Type the code instead'),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _CameraProblem extends StatelessWidget {
  const _CameraProblem({required this.error});

  final MobileScannerException error;

  @override
  Widget build(BuildContext context) {
    final denied = error.errorCode == MobileScannerErrorCode.permissionDenied;
    return ColoredBox(
      color: Colors.black,
      child: Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.no_photography_outlined, color: Colors.white, size: 48),
              const SizedBox(height: 14),
              Text(
                denied
                    ? 'Deligro Rider needs the camera to scan. Allow it in Settings, or type the code instead.'
                    : "The camera isn't available. Type the code instead.",
                textAlign: TextAlign.center,
                style: const TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w600),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
