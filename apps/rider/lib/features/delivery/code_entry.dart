import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../theme/app_theme.dart';

/// The handover codes are four digits (kitchen's pickup code, customer's
/// delivery code).
const codeLength = 4;

/// What [showCodeSheet] does with a full code: null closes the sheet (done,
/// or saved for later), a sentence keeps it open with that error and empty
/// boxes. [scanned] is true for the code a QR scan filled in.
typedef CodeSubmit = Future<String?> Function(String code, {required bool scanned});

/// Four big boxes over one hidden number field: thumb-sized, readable at arm's
/// length in sunlight, and sent as soon as the fourth digit is in.
class CodeEntry extends StatefulWidget {
  const CodeEntry({
    super.key,
    required this.controller,
    required this.onCompleted,
    this.enabled = true,
    this.error = false,
    this.autofocus = true,
  });

  final TextEditingController controller;
  final ValueChanged<String> onCompleted;
  final bool enabled;
  final bool error;
  final bool autofocus;

  @override
  State<CodeEntry> createState() => _CodeEntryState();
}

class _CodeEntryState extends State<CodeEntry> {
  final _focus = FocusNode();

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_changed);
  }

  @override
  void didUpdateWidget(covariant CodeEntry old) {
    super.didUpdateWidget(old);
    if (old.controller != widget.controller) {
      old.controller.removeListener(_changed);
      widget.controller.addListener(_changed);
    }
  }

  @override
  void dispose() {
    widget.controller.removeListener(_changed);
    _focus.dispose();
    super.dispose();
  }

  void _changed() {
    if (!mounted) return;
    setState(() {});
    final text = widget.controller.text;
    if (text.length == codeLength && widget.enabled) widget.onCompleted(text);
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final text = widget.controller.text;
    return Semantics(
      label: 'Code, $codeLength digits',
      textField: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () => _focus.requestFocus(),
        child: Stack(
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                for (var i = 0; i < codeLength; i++) ...[
                  if (i > 0) const SizedBox(width: 12),
                  Container(
                    key: Key('code-box-$i'),
                    width: 60,
                    height: 72,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: c.surface,
                      borderRadius: BorderRadius.circular(radiusBlock),
                      border: Border.all(
                        color: widget.error
                            ? c.deal
                            : i == text.length
                                ? c.accent
                                : c.line,
                        width: i == text.length || widget.error ? 2.4 : 1.6,
                      ),
                    ),
                    child: Text(
                      i < text.length ? text[i] : '',
                      style: dataStyle(context, size: 32, weight: FontWeight.w800),
                      textScaler: TextScaler.noScaling,
                    ),
                  ),
                ],
              ],
            ),
            // The real field, invisible: the boxes draw what it holds.
            Positioned.fill(
              child: Opacity(
                opacity: 0,
                child: TextField(
                  key: const Key('code-field'),
                  controller: widget.controller,
                  focusNode: _focus,
                  autofocus: widget.autofocus,
                  enabled: widget.enabled,
                  keyboardType: TextInputType.number,
                  textInputAction: TextInputAction.done,
                  maxLength: codeLength,
                  showCursor: false,
                  enableInteractiveSelection: false,
                  autofillHints: const [AutofillHints.oneTimeCode],
                  inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(codeLength)],
                  decoration: const InputDecoration(counterText: '', border: InputBorder.none, filled: false),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A sheet that asks for a four-digit code and sends it. [initial] is a
/// scanned code: it is filled in and sent at once.
Future<void> showCodeSheet(
  BuildContext context, {
  required String title,
  required String hint,
  required CodeSubmit submit,
  String? initial,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (context) => _CodeSheet(title: title, hint: hint, submit: submit, initial: initial),
  );
}

class _CodeSheet extends StatefulWidget {
  const _CodeSheet({required this.title, required this.hint, required this.submit, this.initial});

  final String title;
  final String hint;
  final CodeSubmit submit;
  final String? initial;

  @override
  State<_CodeSheet> createState() => _CodeSheetState();
}

class _CodeSheetState extends State<_CodeSheet> {
  final _code = TextEditingController();
  bool _busy = false;
  String? _error;
  bool _scanned = false;

  @override
  void initState() {
    super.initState();
    final scanned = (widget.initial ?? '').replaceAll(RegExp(r'\D'), '');
    if (scanned.isNotEmpty) {
      _scanned = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        // A full code sends itself (CodeEntry); a short one waits for typing.
        if (scanned.length < codeLength) _scanned = false;
        _code.text = scanned.length > codeLength ? scanned.substring(0, codeLength) : scanned;
      });
    }
  }

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  Future<void> _send(String code) async {
    if (_busy) return;
    final scanned = _scanned;
    _scanned = false; // anything typed after this is typed
    setState(() {
      _busy = true;
      _error = null;
    });
    final error = await widget.submit(code, scanned: scanned);
    if (!mounted) return;
    if (error == null) {
      Navigator.of(context).pop();
      return;
    }
    setState(() {
      _busy = false;
      _error = error;
    });
    _code.clear();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.viewInsetsOf(context).bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(widget.title, style: Theme.of(context).textTheme.titleLarge, textAlign: TextAlign.center),
          const SizedBox(height: 6),
          Text(widget.hint, style: TextStyle(color: c.muted, fontSize: 15), textAlign: TextAlign.center),
          const SizedBox(height: 20),
          CodeEntry(controller: _code, onCompleted: _send, enabled: !_busy, error: _error != null),
          const SizedBox(height: 14),
          ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 48),
            child: Center(
              child: _busy
                  ? const SizedBox(width: 28, height: 28, child: CircularProgressIndicator(strokeWidth: 3))
                  : _error != null
                      ? Semantics(
                          liveRegion: true,
                          child: Text(
                            _error!,
                            key: const Key('code-error'),
                            textAlign: TextAlign.center,
                            style: TextStyle(color: c.deal, fontWeight: FontWeight.w800, fontSize: 15),
                          ),
                        )
                      : const SizedBox.shrink(),
            ),
          ),
        ],
      ),
    );
  }
}
