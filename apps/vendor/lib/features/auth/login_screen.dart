import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/api.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';

const _codeLen = 6;
final _mobile = RegExp(r'^[6-9]\d{9}$');

enum _Method { otp, password }

/// Partner sign-in: phone OTP, or the mobile number (or email) and password
/// Deligro set up at onboarding. The router moves a signed-in vendor on.
class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _phone = TextEditingController();
  final _code = TextEditingController();
  final _codeFocus = FocusNode();
  final _login = TextEditingController();
  final _password = TextEditingController();

  _Method _method = _Method.otp;
  bool _codeStep = false;
  bool _busy = false;
  bool _showPassword = false;
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
    _login.addListener(() => setState(() {}));
    _password.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _ticker?.cancel();
    _phone.dispose();
    _code.dispose();
    _codeFocus.dispose();
    _login.dispose();
    _password.dispose();
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
      final res = await ref.read(authRepoProvider).requestOtp('+91$_digits');
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
          _error = retry == null ? e.friendly() : 'Please wait $retry seconds before asking for another code.';
        } else if ((e.code == 'too_many' || e.code == 'daily_limit' || e.code == 'rate_limited') && retry != null) {
          _blockedUntil = DateTime.now().add(Duration(seconds: retry));
          _blockKind = e.code;
          _error = null;
        } else {
          _error = e.friendly();
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
      await ref.read(authRepoProvider).verifyOtp('+91$_digits', code);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.friendly());
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not sign you in. Try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  bool get _canPasswordLogin => !_busy && _login.text.trim().isNotEmpty && _password.text.isNotEmpty;

  Future<void> _passwordLogin() async {
    if (!_canPasswordLogin) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(authRepoProvider).passwordLogin(_login.text, _password.text);
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          if (e.status == 429) {
            final retry = (e.body['retryAfter'] as num?)?.round();
            _error = retry == null
                ? friendlyErrorFor('rate_limited')
                : 'Too many sign-in attempts. Try again in ${_waitText(retry)}.';
          } else {
            _error = e.friendly();
          }
        });
      }
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not sign you in. Try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String friendlyErrorFor(String code) => ApiException(0, code).friendly();

  void _changeNumber() {
    setState(() {
      _codeStep = false;
      _code.clear();
      _error = null;
      _devCode = null;
    });
  }

  void _switchMethod(_Method m) {
    setState(() {
      _method = m;
      _error = null;
      _codeStep = false;
      _code.clear();
    });
  }

  String _waitText(int s) {
    if (s < 60) return '${s}s';
    final mins = (s / 60).ceil();
    if (mins < 60) return '$mins min';
    final h = mins ~/ 60, m = mins % 60;
    return m == 0 ? '$h h' : '$h h $m min';
  }

  String? _limitText(WidgetRef ref) {
    if (!_blocked) return null;
    if (_blockKind == 'daily_limit') {
      return 'You\'ve reached today\'s OTP limit. Use your password, or try again tomorrow.';
    }
    final at = DateFormat('h:mm a').format(_blockedUntil!);
    return 'Too many OTP requests. Please try again after $at.';
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Scaffold(
      body: SafeArea(
        child: Stack(
          children: [
            Center(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(24, 48, 24, 32),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 400),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      const _BrandHeader(),
                      const SizedBox(height: 28),
                      if (!_codeStep) ...[
                        SegmentedButton<_Method>(
                          segments: [
                            ButtonSegment(
                              value: _Method.otp,
                              icon: const Icon(Icons.sms_outlined, size: 18),
                              label: Text('OTP'),
                            ),
                            ButtonSegment(
                              value: _Method.password,
                              icon: const Icon(Icons.key_rounded, size: 18),
                              label: Text('Password'),
                            ),
                          ],
                          selected: {_method},
                          showSelectedIcon: false,
                          onSelectionChanged: _busy ? null : (s) => _switchMethod(s.first),
                        ),
                        const SizedBox(height: 22),
                      ],
                      AnimatedSwitcher(
                        duration: const Duration(milliseconds: 220),
                        child: switch ((_method, _codeStep)) {
                          (_Method.password, _) => _buildPasswordStep(context),
                          (_Method.otp, false) => _buildPhoneStep(context),
                          (_Method.otp, true) => _buildCodeStep(context),
                        },
                      ),
                      const SizedBox(height: 24),
                      Text(
                        'For shops partnered with Deligro. Sign-in attempts are limited for your security.',
                        textAlign: TextAlign.center,
                        style: TextStyle(fontSize: 12, height: 1.5, color: c.muted),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _phoneField(
    BuildContext context, {
    required TextEditingController controller,
    required ValueChanged<String> onSubmitted,
  }) {
    final c = context.colors;
    return Row(
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
            child: Text('🇮🇳 +91', style: dataStyle(context, size: 15, weight: FontWeight.w700)),
          ),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: TextField(
            controller: controller,
            autofocus: true,
            keyboardType: TextInputType.phone,
            textInputAction: TextInputAction.done,
            autofillHints: const [AutofillHints.telephoneNumberNational],
            inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(10)],
            style: dataStyle(context, size: 17, weight: FontWeight.w700),
            decoration: InputDecoration(hintText: 'Mobile number', counterText: ''),
            onSubmitted: onSubmitted,
          ),
        ),
      ],
    );
  }

  Widget _buildPhoneStep(BuildContext context) {
    final canSend = _validPhone && !_busy && !_blocked;
    final limit = _limitText(ref);
    return Column(
      key: const ValueKey('phone'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _phoneField(context, controller: _phone, onSubmitted: (_) => _requestCode()),
        if (_digits.length == 10 && !_validPhone) _Notice(text: friendlyErrorFor('invalid_phone'), tone: _Tone.error),
        if (limit != null) _Notice(text: limit, tone: _Tone.limit),
        if (_error != null) _Notice(text: _error!, tone: _Tone.error),
        const SizedBox(height: 16),
        FilledButton(
          onPressed: canSend ? _requestCode : null,
          child: _busy ? const _Spinner() : Text(_blocked ? 'Try again in ${_waitText(_blockLeft)}' : 'Get OTP'),
        ),
      ],
    );
  }

  Widget _buildCodeStep(BuildContext context) {
    final c = context.colors;
    final limit = _limitText(ref);
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
            label: Text('Change number'),
            style: TextButton.styleFrom(
              foregroundColor: c.ink,
              minimumSize: const Size(44, 44),
              padding: const EdgeInsets.only(right: 12),
            ),
          ),
        ),
        const SizedBox(height: 8),
        Text('Enter the OTP', style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontSize: 23)),
        const SizedBox(height: 6),
        Text('We sent an OTP to +91 $_digits', style: TextStyle(color: c.muted, fontSize: 14)),
        const SizedBox(height: 22),
        _CodeBoxes(
          controller: _code,
          focusNode: _codeFocus,
          label: 'Enter 6-digit OTP',
          onChanged: (v) {
            setState(() {});
            if (v.length == _codeLen) _verify();
          },
        ),
        if (_devCode != null)
          Container(
            margin: const EdgeInsets.only(top: 12),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
            decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(12)),
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
        if (limit != null) _Notice(text: limit, tone: _Tone.limit),
        if (_error != null) _Notice(text: _error!, tone: _Tone.error),
        const SizedBox(height: 16),
        FilledButton(
          onPressed: !_busy && _code.text.length == _codeLen ? _verify : null,
          child: _busy ? const _Spinner() : Text('Verify & continue'),
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

  Widget _buildPasswordStep(BuildContext context) {
    return AutofillGroup(
      key: const ValueKey('password'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          TextField(
            controller: _login,
            autofocus: true,
            keyboardType: TextInputType.emailAddress,
            textInputAction: TextInputAction.next,
            autofillHints: const [AutofillHints.username, AutofillHints.telephoneNumberNational],
            decoration: InputDecoration(
              labelText: 'Mobile number or email',
              prefixIcon: const Icon(Icons.person_outline_rounded),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _password,
            obscureText: !_showPassword,
            textInputAction: TextInputAction.done,
            autofillHints: const [AutofillHints.password],
            decoration: InputDecoration(
              labelText: 'Password',
              prefixIcon: const Icon(Icons.lock_outline_rounded),
              suffixIcon: IconButton(
                tooltip: _showPassword ? 'Hide password' : 'Show password',
                onPressed: () => setState(() => _showPassword = !_showPassword),
                icon: Icon(_showPassword ? Icons.visibility_off_outlined : Icons.visibility_outlined),
              ),
            ),
            onSubmitted: (_) => _passwordLogin(),
          ),
          if (_error != null) _Notice(text: _error!, tone: _Tone.error),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: _canPasswordLogin ? _passwordLogin : null,
            child: _busy ? const _Spinner() : Text('Sign in'),
          ),
          const SizedBox(height: 10),
          Text(
            'Use the login Deligro gave you when your shop joined. Forgot it? Sign in with OTP.',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 12.5, height: 1.45, color: context.colors.muted),
          ),
        ],
      ),
    );
  }
}

class _BrandHeader extends ConsumerWidget {
  const _BrandHeader();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    return Column(
      children: [
        Container(
          width: 76,
          height: 76,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(19),
            boxShadow: const [BoxShadow(color: Color(0x59E59A01), blurRadius: 24, offset: Offset(0, 8))],
          ),
          child: Image.asset('assets/brand/mark.png', width: 76, height: 76),
        ),
        const SizedBox(height: 14),
        Semantics(
          header: true,
          label: 'Deligro Partner',
          excludeSemantics: true,
          child: Text.rich(
            TextSpan(
              text: 'Deligro',
              style: TextStyle(fontSize: 32, fontWeight: FontWeight.w900, letterSpacing: -1.1, color: c.ink),
              children: [
                TextSpan(
                  text: '.',
                  style: TextStyle(color: c.accent),
                ),
                TextSpan(
                  text: ' Partner',
                  style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700, letterSpacing: -.4, color: c.muted),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 4),
        Text(
          'Run your shop on Deligro',
          style: TextStyle(color: c.muted, fontSize: 14, fontWeight: FontWeight.w500),
        ),
      ],
    );
  }
}

/// Six boxes over one invisible field, so paste and SMS autofill still work.
class _CodeBoxes extends StatelessWidget {
  const _CodeBoxes({required this.controller, required this.focusNode, required this.onChanged, required this.label});
  final TextEditingController controller;
  final FocusNode focusNode;
  final ValueChanged<String> onChanged;
  final String label;

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
                child: Builder(
                  builder: (context) {
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
                      child: Text(filled ? code[i] : '', style: dataStyle(context, size: 22, weight: FontWeight.w800)),
                    );
                  },
                ),
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
              inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(_codeLen)],
              showCursor: false,
              enableInteractiveSelection: false,
              decoration: InputDecoration(
                filled: false,
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                counterText: '',
                labelText: label,
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
  Widget build(BuildContext context) =>
      SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.4, color: context.colors.muted));
}
