import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api.dart';
import '../../core/i18n.dart';
import '../../data/auth_repository.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';

enum _Method { password, otp, email }

/// Manager sign-in: the mobile number and password an admin created on Team
/// (the default), a phone OTP, or email and password. The router moves a
/// signed-in manager on; this screen never decides access.
class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _mobile = TextEditingController();
  final _password = TextEditingController();
  final _email = TextEditingController();
  final _emailPassword = TextEditingController();
  final _otpMobile = TextEditingController();
  final _otpCode = TextEditingController();

  _Method _method = _Method.password;
  bool _busy = false;
  bool _showPassword = false;
  bool _codeStep = false;
  String? _error;
  String? _devCode;
  int _cooldown = 0;
  Timer? _ticker;

  @override
  void dispose() {
    _ticker?.cancel();
    for (final c in [_mobile, _password, _email, _emailPassword, _otpMobile, _otpCode]) {
      c.dispose();
    }
    super.dispose();
  }

  String _message(Object e) {
    if (e is ApiException) {
      if (e.code == 'invalid_phone') {
        return trNow(ref, 'Enter a valid 10-digit Indian mobile number.', 'सही 10 अंकों का मोबाइल नंबर डालें।');
      }
      if (e.code == 'bad_credentials') {
        return trNow(ref, 'Wrong mobile number, email or password.', 'मोबाइल नंबर, ईमेल या पासवर्ड गलत है।');
      }
      return e.friendly;
    }
    return trNow(ref, 'Something went wrong. Please try again.', 'कुछ गड़बड़ हुई। फिर से कोशिश करें।');
  }

  Future<void> _run(Future<void> Function() action) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await action();
    } catch (e) {
      if (mounted) setState(() => _error = _message(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  AuthRepository get _repo => ref.read(authRepoProvider);

  void _submitPassword() {
    if (AuthRepository.normaliseMobile(_mobile.text) == null) {
      setState(() => _error = _message(ApiException(400, 'invalid_phone')));
      return;
    }
    if (_password.text.isEmpty) return;
    _run(() => _repo.passwordLogin(_mobile.text, _password.text));
  }

  void _submitEmail() {
    if (!_email.text.contains('@') || _emailPassword.text.isEmpty) {
      setState(() => _error = trNow(ref, 'Enter your email and password.', 'ईमेल और पासवर्ड डालें।'));
      return;
    }
    _run(() => _repo.emailLogin(_email.text, _emailPassword.text));
  }

  void _sendCode() {
    final phone = AuthRepository.normaliseMobile(_otpMobile.text);
    if (phone == null) {
      setState(() => _error = _message(ApiException(400, 'invalid_phone')));
      return;
    }
    _run(() async {
      final r = await _repo.requestOtp(phone);
      if (!mounted) return;
      setState(() {
        _codeStep = true;
        _devCode = r.devCode;
        _cooldown = 30;
      });
      _ticker?.cancel();
      _ticker = Timer.periodic(const Duration(seconds: 1), (t) {
        if (!mounted || _cooldown <= 0) {
          t.cancel();
          return;
        }
        setState(() => _cooldown--);
      });
    });
  }

  void _verifyCode() {
    final phone = AuthRepository.normaliseMobile(_otpMobile.text);
    if (phone == null || _otpCode.text.length != 6) return;
    _run(() => _repo.verifyOtp(phone, _otpCode.text));
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Scaffold(
      backgroundColor: c.bg,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(20, 24, 20, 32),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _Brand(),
                  const SizedBox(height: 28),
                  _MethodPicker(
                    value: _method,
                    labels: {
                      _Method.password: tr(ref, 'Mobile & password', 'मोबाइल और पासवर्ड'),
                      _Method.otp: 'OTP',
                      _Method.email: tr(ref, 'Email', 'ईमेल'),
                    },
                    onChanged: _busy
                        ? null
                        : (m) => setState(() {
                              _method = m;
                              _error = null;
                            }),
                  ),
                  const SizedBox(height: 20),
                  ...switch (_method) {
                    _Method.password => _passwordForm(),
                    _Method.otp => _otpForm(),
                    _Method.email => _emailForm(),
                  },
                  if (_error != null) ...[
                    const SizedBox(height: 14),
                    _ErrorLine(_error!),
                  ],
                  const SizedBox(height: 24),
                  Text(
                    tr(
                      ref,
                      'For Deligro operations staff. Your login is created by an admin.',
                      'Deligro संचालन टीम के लिए। आपका लॉगिन एडमिन बनाते हैं।',
                    ),
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 12.5, color: c.muted),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  List<Widget> _passwordForm() => [
        _Input(
          key: const Key('login-mobile'),
          controller: _mobile,
          label: tr(ref, 'Mobile number', 'मोबाइल नंबर'),
          keyboard: TextInputType.phone,
          prefix: '+91 ',
          formatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9 +-]')), LengthLimitingTextInputFormatter(16)],
        ),
        const SizedBox(height: 12),
        _Input(
          key: const Key('login-password'),
          controller: _password,
          label: tr(ref, 'Password', 'पासवर्ड'),
          obscure: !_showPassword,
          onSubmit: _submitPassword,
          suffix: IconButton(
            tooltip: _showPassword ? tr(ref, 'Hide password', 'पासवर्ड छिपाएँ') : tr(ref, 'Show password', 'पासवर्ड दिखाएँ'),
            icon: Icon(_showPassword ? Icons.visibility_off_outlined : Icons.visibility_outlined),
            onPressed: () => setState(() => _showPassword = !_showPassword),
          ),
        ),
        const SizedBox(height: 18),
        _Submit(
          key: const Key('login-submit'),
          label: tr(ref, 'Sign in', 'साइन इन'),
          busy: _busy,
          onPressed: _submitPassword,
        ),
      ];

  List<Widget> _emailForm() => [
        _Input(
          key: const Key('login-email'),
          controller: _email,
          label: tr(ref, 'Email', 'ईमेल'),
          keyboard: TextInputType.emailAddress,
        ),
        const SizedBox(height: 12),
        _Input(
          key: const Key('login-email-password'),
          controller: _emailPassword,
          label: tr(ref, 'Password', 'पासवर्ड'),
          obscure: !_showPassword,
          onSubmit: _submitEmail,
        ),
        const SizedBox(height: 18),
        _Submit(
          key: const Key('login-email-submit'),
          label: tr(ref, 'Sign in', 'साइन इन'),
          busy: _busy,
          onPressed: _submitEmail,
        ),
      ];

  List<Widget> _otpForm() => [
        _Input(
          key: const Key('otp-mobile'),
          controller: _otpMobile,
          label: tr(ref, 'Mobile number', 'मोबाइल नंबर'),
          keyboard: TextInputType.phone,
          prefix: '+91 ',
          enabled: !_codeStep,
          formatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9 +-]')), LengthLimitingTextInputFormatter(16)],
        ),
        const SizedBox(height: 12),
        if (!_codeStep)
          _Submit(
            key: const Key('otp-send'),
            label: tr(ref, 'Send code', 'कोड भेजें'),
            busy: _busy,
            onPressed: _sendCode,
          )
        else ...[
          _Input(
            key: const Key('otp-code'),
            controller: _otpCode,
            label: tr(ref, '6-digit code', '6 अंकों का कोड'),
            keyboard: TextInputType.number,
            formatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
            onSubmit: _verifyCode,
          ),
          if (_devCode != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text('Test code: $_devCode', style: dataStyle(context, size: 12)),
            ),
          const SizedBox(height: 18),
          _Submit(
            key: const Key('otp-verify'),
            label: tr(ref, 'Verify and sign in', 'पुष्टि करें और साइन इन करें'),
            busy: _busy,
            onPressed: _verifyCode,
          ),
          const SizedBox(height: 6),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              TextButton(
                onPressed: _busy
                    ? null
                    : () => setState(() {
                          _codeStep = false;
                          _otpCode.clear();
                        }),
                child: Text(tr(ref, 'Change number', 'नंबर बदलें')),
              ),
              TextButton(
                onPressed: _busy || _cooldown > 0 ? null : _sendCode,
                child: Text(_cooldown > 0
                    ? tr(ref, 'Resend in ${_cooldown}s', '${_cooldown}s में फिर भेजें')
                    : tr(ref, 'Resend code', 'कोड फिर भेजें')),
              ),
            ],
          ),
        ],
      ];
}

class _Brand extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Column(
      children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(radiusBlock),
          child: Image.asset('assets/brand/mark.png', width: 64, height: 64),
        ),
        const SizedBox(height: 14),
        Text('Deligro Manager',
            style: TextStyle(fontSize: 24, fontWeight: FontWeight.w800, color: c.ink, letterSpacing: -0.4)),
        const SizedBox(height: 4),
        Text('Operations', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: c.muted)),
      ],
    );
  }
}

class _MethodPicker extends StatelessWidget {
  const _MethodPicker({required this.value, required this.labels, required this.onChanged});

  final _Method value;
  final Map<_Method, String> labels;
  final ValueChanged<_Method>? onChanged;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: c.surface2,
        borderRadius: BorderRadius.circular(radiusBlock),
      ),
      child: Row(
        children: [
          for (final m in _Method.values)
            Expanded(
              child: Semantics(
                selected: m == value,
                button: true,
                child: InkWell(
                  borderRadius: BorderRadius.circular(radiusBlock - 4),
                  onTap: onChanged == null ? null : () => onChanged!(m),
                  child: AnimatedContainer(
                    duration: const Duration(milliseconds: 150),
                    constraints: const BoxConstraints(minHeight: 44),
                    alignment: Alignment.center,
                    padding: const EdgeInsets.symmetric(horizontal: 6),
                    decoration: BoxDecoration(
                      color: m == value ? c.surface : Colors.transparent,
                      borderRadius: BorderRadius.circular(radiusBlock - 4),
                    ),
                    child: Text(
                      labels[m]!,
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        fontSize: 13,
                        fontWeight: m == value ? FontWeight.w700 : FontWeight.w600,
                        color: m == value ? c.ink : c.muted,
                      ),
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _Input extends StatelessWidget {
  const _Input({
    super.key,
    required this.controller,
    required this.label,
    this.keyboard,
    this.obscure = false,
    this.prefix,
    this.suffix,
    this.formatters,
    this.onSubmit,
    this.enabled = true,
  });

  final TextEditingController controller;
  final String label;
  final TextInputType? keyboard;
  final bool obscure;
  final String? prefix;
  final Widget? suffix;
  final List<TextInputFormatter>? formatters;
  final VoidCallback? onSubmit;
  final bool enabled;

  @override
  Widget build(BuildContext context) => TextField(
        controller: controller,
        keyboardType: keyboard,
        obscureText: obscure,
        enabled: enabled,
        inputFormatters: formatters,
        autocorrect: false,
        enableSuggestions: !obscure,
        onSubmitted: onSubmit == null ? null : (_) => onSubmit!(),
        decoration: InputDecoration(labelText: label, prefixText: prefix, suffixIcon: suffix),
      );
}

class _Submit extends StatelessWidget {
  const _Submit({super.key, required this.label, required this.busy, required this.onPressed});

  final String label;
  final bool busy;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) => FilledButton(
        onPressed: busy ? null : onPressed,
        style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(50)),
        child: busy
            ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2.4))
            : Text(label, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
      );
}

class _ErrorLine extends StatelessWidget {
  const _ErrorLine(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Semantics(
      liveRegion: true,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(color: c.dealSoft, borderRadius: BorderRadius.circular(12)),
        child: Text(text, style: TextStyle(color: c.deal, fontWeight: FontWeight.w600, fontSize: 13.5)),
      ),
    );
  }
}
