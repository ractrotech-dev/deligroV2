import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../core/api.dart';
import '../../state/prefs.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';

const _codeLen = 6;
final _mobile = RegExp(r'^[6-9]\d{9}$');

/// Phone-OTP sign-in (app/login/page.tsx + components/auth/otp-login.tsx).
/// The router's redirect moves a signed-in user on to `next`.
class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key, this.next});
  final String? next;

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _phone = TextEditingController();
  final _code = TextEditingController();
  final _codeFocus = FocusNode();

  bool _codeStep = false;
  bool _busy = false;
  String? _error;
  String? _devCode;
  int _cooldown = 0;
  Timer? _ticker;

  /// A send limit the server reported (too_many / daily_limit / rate_limited).
  DateTime? _blockedUntil;
  String? _blockKind;

  @override
  void initState() {
    super.initState();
    _phone.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _ticker?.cancel();
    _phone.dispose();
    _code.dispose();
    _codeFocus.dispose();
    super.dispose();
  }

  String get _digits => _phone.text;
  bool get _validPhone => _mobile.hasMatch(_digits);

  int get _blockLeft {
    final until = _blockedUntil;
    if (until == null) return 0;
    final s = until.difference(DateTime.now()).inSeconds;
    return s > 0 ? s : 0;
  }

  bool get _blocked => _blockLeft > 0;

  /// One clock for both the resend countdown and a send block.
  void _startTicker() {
    _ticker?.cancel();
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      setState(() {
        if (_cooldown > 0) _cooldown--;
        if (_blockedUntil != null && !_blocked) {
          _blockedUntil = null;
          _blockKind = null;
        }
      });
      if (_cooldown <= 0 && _blockedUntil == null) _ticker?.cancel();
    });
  }

  Future<void> _requestCode() async {
    if (!_validPhone || _busy || _blocked) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final res = await ref.read(accountRepoProvider).requestOtp('+91$_digits');
      if (!mounted) return;
      setState(() {
        _devCode = res.devCode;
        _cooldown = 30;
        _codeStep = true;
        _code.clear();
      });
      _startTicker();
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _codeFocus.requestFocus();
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      final retry = (e.body['retryAfter'] as num?)?.round();
      setState(() {
        if (e.code == 'cooldown') {
          _cooldown = retry ?? 30;
          _error = retry == null
              ? e.friendly
              : 'Please wait $retry seconds before asking for another code.';
        } else if ((e.code == 'too_many' || e.code == 'daily_limit' || e.code == 'rate_limited') &&
            retry != null) {
          _blockedUntil = DateTime.now().add(Duration(seconds: retry));
          _blockKind = e.code;
          _error = null;
        } else {
          _error = e.friendly;
        }
      });
      _startTicker();
    } catch (_) {
      if (mounted) setState(() => _error = 'Network error — please try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _verify() async {
    final code = _code.text;
    if (code.length != _codeLen || _busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(accountRepoProvider).verifyOtp('+91$_digits', code);
      ref.read(guestProvider.notifier).set(false);
      if (!mounted) return;
      final next = widget.next;
      // The redirect already does this on the auth event; this covers a
      // router that hasn't re-evaluated yet.
      final safe = next != null && next.startsWith('/') && !next.startsWith('/login');
      context.go(safe ? next : '/');
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.friendly);
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not sign you in. Try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _changeNumber() {
    setState(() {
      _codeStep = false;
      _code.clear();
      _error = null;
      _devCode = null;
    });
  }

  String _waitText(int s) {
    if (s < 60) return '${s}s';
    final mins = (s / 60).ceil();
    if (mins < 60) return '$mins min';
    final h = mins ~/ 60, m = mins % 60;
    return m == 0 ? '$h h' : '$h h $m min';
  }

  String? get _limitText {
    if (!_blocked) return null;
    if (_blockKind == 'daily_limit') {
      return 'You\'ve reached today\'s OTP limit. Please try again tomorrow.';
    }
    final at = DateFormat('h:mm a').format(_blockedUntil!);
    return 'Too many OTP requests. Please try again after $at.';
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final next = widget.next;
    final showGuest = next == null || next == '/';

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 400),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const _BrandHeader(),
                  const SizedBox(height: 36),
                  AnimatedSwitcher(
                    duration: const Duration(milliseconds: 220),
                    child: _codeStep ? _buildCodeStep(context) : _buildPhoneStep(context),
                  ),
                  if (showGuest && !_codeStep) ...[
                    const SizedBox(height: 12),
                    TextButton(
                      onPressed: _busy
                          ? null
                          : () {
                              ref.read(guestProvider.notifier).set(true);
                              context.go('/');
                            },
                      style: TextButton.styleFrom(
                        foregroundColor: c.muted,
                        minimumSize: const Size.fromHeight(48),
                      ),
                      child: const Text('Browse as guest'),
                    ),
                  ],
                  const SizedBox(height: 20),
                  Text(
                    'By continuing you agree to Deligro\'s Terms & Conditions and '
                    'Privacy Policy. OTP login is rate-limited per phone number.',
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 12, height: 1.5, color: c.muted),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildPhoneStep(BuildContext context) {
    final c = context.colors;
    final canSend = _validPhone && !_busy && !_blocked;
    return Column(
      key: const ValueKey('phone'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('Sign in',
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontSize: 23)),
        const SizedBox(height: 6),
        Text('We\'ll text you a one-time code.',
            textAlign: TextAlign.center, style: TextStyle(color: c.muted, fontSize: 14)),
        const SizedBox(height: 24),
        Row(
          children: [
            Container(
              height: 52,
              padding: const EdgeInsets.symmetric(horizontal: 14),
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: c.surface2,
                borderRadius: BorderRadius.circular(radiusBlock),
                border: Border.all(color: c.line),
              ),
              child: Semantics(
                label: 'India, country code plus 91',
                excludeSemantics: true,
                child: Text('🇮🇳 +91',
                    style: dataStyle(context, size: 15, weight: FontWeight.w700)),
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: TextField(
                controller: _phone,
                autofocus: true,
                keyboardType: TextInputType.phone,
                textInputAction: TextInputAction.done,
                autofillHints: const [AutofillHints.telephoneNumberNational],
                inputFormatters: [
                  FilteringTextInputFormatter.digitsOnly,
                  LengthLimitingTextInputFormatter(10),
                ],
                style: dataStyle(context, size: 17, weight: FontWeight.w700),
                decoration: const InputDecoration(
                  hintText: 'Mobile number',
                  counterText: '',
                ),
                onSubmitted: (_) => _requestCode(),
              ),
            ),
          ],
        ),
        if (_digits.length == 10 && !_validPhone)
          _Notice(text: 'Enter a valid 10-digit Indian mobile number.', tone: _Tone.error),
        if (_limitText != null) _Notice(text: _limitText!, tone: _Tone.limit),
        if (_error != null) _Notice(text: _error!, tone: _Tone.error),
        const SizedBox(height: 16),
        FilledButton(
          onPressed: canSend ? _requestCode : null,
          child: _busy
              ? const _Spinner()
              : Text(_blocked ? 'Try again in ${_waitText(_blockLeft)}' : 'Get OTP'),
        ),
      ],
    );
  }

  Widget _buildCodeStep(BuildContext context) {
    final c = context.colors;
    final resendLabel = _blocked
        ? 'Try again in ${_waitText(_blockLeft)}'
        : _cooldown > 0
            ? 'Resend OTP in ${_cooldown}s'
            : 'Resend OTP';
    return Column(
      key: const ValueKey('code'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton.icon(
            onPressed: _busy ? null : _changeNumber,
            icon: const Icon(Icons.chevron_left_rounded),
            label: const Text('Change number'),
            style: TextButton.styleFrom(
              foregroundColor: c.ink,
              minimumSize: const Size(44, 44),
              padding: const EdgeInsets.only(right: 12),
            ),
          ),
        ),
        const SizedBox(height: 8),
        Text('Enter the OTP',
            style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontSize: 23)),
        const SizedBox(height: 6),
        Text('We sent an OTP to +91 $_digits', style: TextStyle(color: c.muted, fontSize: 14)),
        const SizedBox(height: 22),
        _CodeBoxes(
          controller: _code,
          focusNode: _codeFocus,
          onChanged: (v) {
            setState(() {});
            if (v.length == _codeLen) _verify();
          },
        ),
        if (_devCode != null)
          Container(
            margin: const EdgeInsets.only(top: 12),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
            decoration: BoxDecoration(
              color: c.surface2,
              borderRadius: BorderRadius.circular(12),
            ),
            child: Text.rich(
              TextSpan(
                text: 'Test mode: your code is ',
                style: TextStyle(color: c.muted, fontSize: 13),
                children: [
                  TextSpan(
                    text: _devCode,
                    style: dataStyle(context, size: 13, weight: FontWeight.w800),
                  ),
                ],
              ),
              textAlign: TextAlign.center,
            ),
          ),
        if (_limitText != null) _Notice(text: _limitText!, tone: _Tone.limit),
        if (_error != null) _Notice(text: _error!, tone: _Tone.error),
        const SizedBox(height: 16),
        FilledButton(
          onPressed: !_busy && _code.text.length == _codeLen ? _verify : null,
          child: _busy ? const _Spinner() : const Text('Verify & continue'),
        ),
        const SizedBox(height: 8),
        TextButton(
          onPressed: _cooldown > 0 || _busy || _blocked ? null : _requestCode,
          style: TextButton.styleFrom(minimumSize: const Size.fromHeight(48)),
          child: Text(resendLabel),
        ),
      ],
    );
  }
}

class _BrandHeader extends StatelessWidget {
  const _BrandHeader();

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Column(
      children: [
        Container(
          width: 76,
          height: 76,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(19),
            boxShadow: const [
              BoxShadow(color: Color(0x59E69A02), blurRadius: 24, offset: Offset(0, 8)),
            ],
          ),
          child: Image.asset('assets/brand/mark.png', width: 76, height: 76),
        ),
        const SizedBox(height: 14),
        Semantics(
          header: true,
          label: 'Deligro',
          excludeSemantics: true,
          child: Text.rich(
            TextSpan(
              text: 'Deligro',
              style: TextStyle(
                fontSize: 34,
                fontWeight: FontWeight.w900,
                letterSpacing: -1.2,
                color: c.ink,
              ),
              children: [TextSpan(text: '.', style: TextStyle(color: c.accent))],
            ),
          ),
        ),
        const SizedBox(height: 4),
        Text('Order in minutes, across Bemetara',
            style: TextStyle(color: c.muted, fontSize: 14, fontWeight: FontWeight.w500)),
      ],
    );
  }
}

/// Six boxes over one invisible field, so paste and SMS autofill still work.
class _CodeBoxes extends StatelessWidget {
  const _CodeBoxes({required this.controller, required this.focusNode, required this.onChanged});
  final TextEditingController controller;
  final FocusNode focusNode;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final code = controller.text;
    return Stack(
      children: [
        Row(
          children: [
            for (var i = 0; i < _codeLen; i++) ...[
              if (i > 0) const SizedBox(width: 8),
              Expanded(
                child: Builder(builder: (context) {
                  final active = i == code.length || (i == _codeLen - 1 && code.length == _codeLen);
                  final filled = i < code.length;
                  return AnimatedContainer(
                    duration: const Duration(milliseconds: 120),
                    height: 54,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: filled || active ? c.surface : c.surface2,
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(
                        color: active ? c.ink : (filled ? c.line : Colors.transparent),
                        width: active ? 2 : 1,
                      ),
                    ),
                    child: Text(
                      filled ? code[i] : '',
                      style: dataStyle(context, size: 22, weight: FontWeight.w800),
                    ),
                  );
                }),
              ),
            ],
          ],
        ),
        Positioned.fill(
          child: Opacity(
            opacity: 0,
            child: TextField(
              controller: controller,
              focusNode: focusNode,
              keyboardType: TextInputType.number,
              autofillHints: const [AutofillHints.oneTimeCode],
              inputFormatters: [
                FilteringTextInputFormatter.digitsOnly,
                LengthLimitingTextInputFormatter(_codeLen),
              ],
              showCursor: false,
              enableInteractiveSelection: false,
              decoration: const InputDecoration(
                filled: false,
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                counterText: '',
                labelText: 'Enter 6-digit OTP',
              ),
              onChanged: onChanged,
            ),
          ),
        ),
      ],
    );
  }
}

enum _Tone { error, limit }

class _Notice extends StatelessWidget {
  const _Notice({required this.text, required this.tone});
  final String text;
  final _Tone tone;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Semantics(
      liveRegion: true,
      child: Container(
        margin: const EdgeInsets.only(top: 12),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          color: c.dealSoft,
          borderRadius: BorderRadius.circular(12),
          border: tone == _Tone.limit ? Border.all(color: c.deal.withValues(alpha: .4)) : null,
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (tone == _Tone.limit) ...[
              Icon(Icons.warning_amber_rounded, size: 18, color: c.deal),
              const SizedBox(width: 8),
            ],
            Expanded(
              child: Text(
                text,
                textAlign: tone == _Tone.limit ? TextAlign.left : TextAlign.center,
                style: TextStyle(
                  color: c.deal,
                  fontSize: 13.5,
                  fontWeight: tone == _Tone.limit ? FontWeight.w700 : FontWeight.w500,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Spinner extends StatelessWidget {
  const _Spinner();

  @override
  Widget build(BuildContext context) => SizedBox(
        width: 22,
        height: 22,
        child: CircularProgressIndicator(strokeWidth: 2.4, color: context.colors.muted),
      );
}
