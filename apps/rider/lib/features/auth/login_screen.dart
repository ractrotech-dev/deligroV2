import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/api.dart';
import '../../core/errors.dart';
import '../../core/i18n.dart';
import '../../data/auth_repository.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';

const _codeLen = 6;
final _mobile = RegExp(r'^[6-9]\d{9}$');
final _emailShape = RegExp(r'^\S+@\S+$');

/// Sign-in for riders: a phone OTP, or the email and one-time password that
/// Admin → Settings → Employees issues. The router moves a signed-in user on
/// (to the rider's home, or to the gate's explanation); this screen never
/// navigates itself.
class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _phone = TextEditingController();
  final _code = TextEditingController();
  final _codeFocus = FocusNode();
  final _email = TextEditingController();
  final _password = TextEditingController();

  /// 0 = phone OTP, 1 = email and password.
  int _tab = 0;

  bool _codeStep = false;
  bool _busy = false;
  bool _showPassword = false;
  String? _devCode;
  int _cooldown = 0;
  Timer? _ticker;

  /// Held as the error itself, not as text, so a language switch re-words it.
  ApiException? _phoneError;
  SignInFailure? _emailError;
  bool _verifyFailed = false;

  /// A send limit the server reported (too_many / daily_limit / rate_limited).
  DateTime? _blockedUntil;
  String? _blockKind;

  @override
  void initState() {
    super.initState();
    _phone.addListener(() => setState(() {}));
    _email.addListener(() => setState(() {}));
    _password.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _ticker?.cancel();
    _phone.dispose();
    _code.dispose();
    _codeFocus.dispose();
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  String get _digits => _phone.text;
  bool get _validPhone => _mobile.hasMatch(_digits);
  bool get _validEmail => _emailShape.hasMatch(_email.text.trim());

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
      _phoneError = null;
      _verifyFailed = false;
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
          _phoneError = e;
        } else if ((e.code == 'too_many' || e.code == 'daily_limit' || e.code == 'rate_limited') &&
            retry != null) {
          _blockedUntil = DateTime.now().add(Duration(seconds: retry));
          _blockKind = e.code;
        } else {
          _phoneError = e;
        }
      });
      _startTicker();
    } catch (_) {
      if (mounted) setState(() => _phoneError = ApiException(0, 'network'));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _verify() async {
    final code = _code.text;
    if (code.length != _codeLen || _busy) return;
    setState(() {
      _busy = true;
      _phoneError = null;
      _verifyFailed = false;
    });
    try {
      await ref.read(authRepoProvider).verifyOtp('+91$_digits', code);
      // The session event moves the router on; nothing to do here.
    } on ApiException catch (e) {
      if (mounted) setState(() => _phoneError = e);
    } catch (_) {
      if (mounted) setState(() => _verifyFailed = true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _signInWithEmail() async {
    if (!_validEmail || _password.text.isEmpty || _busy) return;
    setState(() {
      _busy = true;
      _emailError = null;
    });
    try {
      await ref.read(authRepoProvider).signInWithEmail(_email.text, _password.text);
    } on SignInException catch (e) {
      if (mounted) setState(() => _emailError = e.kind);
    } catch (_) {
      if (mounted) setState(() => _emailError = SignInFailure.other);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _changeNumber() {
    setState(() {
      _codeStep = false;
      _code.clear();
      _phoneError = null;
      _verifyFailed = false;
      _devCode = null;
    });
  }

  String _waitText(int s) {
    final hi = ref.read(langProvider) == 'hi';
    if (s < 60) return hi ? '$s सेकंड' : '${s}s';
    final mins = (s / 60).ceil();
    if (mins < 60) return hi ? '$mins मिनट' : '$mins min';
    final h = mins ~/ 60, m = mins % 60;
    if (hi) return m == 0 ? '$h घंटे' : '$h घंटे $m मिनट';
    return m == 0 ? '$h h' : '$h h $m min';
  }

  String? _limitText() {
    if (!_blocked) return null;
    if (_blockKind == 'daily_limit') {
      return tr(ref, 'You\'ve reached today\'s OTP limit. Please try again tomorrow.',
          'आज की OTP सीमा पूरी हो गई है। कल फिर कोशिश करें।');
    }
    final at = DateFormat('h:mm a').format(_blockedUntil!);
    return tr(ref, 'Too many OTP requests. Please try again after $at.',
        'OTP के बहुत ज़्यादा अनुरोध। $at के बाद फिर कोशिश करें।');
  }

  String? _phoneErrorText() {
    final lang = ref.watch(langProvider);
    final e = _phoneError;
    if (e != null) {
      final retry = (e.body['retryAfter'] as num?)?.round();
      if (e.code == 'cooldown' && retry != null) {
        return lang == 'hi'
            ? 'दूसरा कोड माँगने से पहले $retry सेकंड रुकें।'
            : 'Please wait $retry seconds before asking for another code.';
      }
      return e.friendlyIn(lang);
    }
    if (_verifyFailed) {
      return tr(ref, 'Could not sign you in. Try again.', 'साइन इन नहीं हो पाया। फिर कोशिश करें।');
    }
    return null;
  }

  String? _emailErrorText() {
    final lang = ref.watch(langProvider);
    return switch (_emailError) {
      null => null,
      SignInFailure.invalidCredentials =>
        tr(ref, 'Wrong email or password.', 'ईमेल या पासवर्ड गलत है।'),
      SignInFailure.network => friendlyError('network', hi: lang == 'hi'),
      SignInFailure.rateLimited => friendlyError('rate_limited', hi: lang == 'hi'),
      SignInFailure.other =>
        tr(ref, 'Could not sign you in. Try again.', 'साइन इन नहीं हो पाया। फिर कोशिश करें।'),
    };
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final lang = ref.watch(langProvider);
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 400),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Align(
                    alignment: Alignment.centerRight,
                    child: TextButton(
                      key: const Key('lang-toggle'),
                      onPressed: () => ref.read(langProvider.notifier).set(lang == 'hi' ? 'en' : 'hi'),
                      style: TextButton.styleFrom(
                        foregroundColor: c.muted,
                        minimumSize: const Size(48, 44),
                      ),
                      child: Text(lang == 'hi' ? 'English' : 'हिन्दी'),
                    ),
                  ),
                  const _BrandHeader(),
                  const SizedBox(height: 24),
                  if (!_codeStep) ...[
                    _Tabs(
                      index: _tab,
                      labels: [
                        tr(ref, 'Phone OTP', 'फ़ोन OTP'),
                        tr(ref, 'Email & password', 'ईमेल और पासवर्ड'),
                      ],
                      onChanged: _busy ? null : (i) => setState(() => _tab = i),
                    ),
                    const SizedBox(height: 22),
                  ],
                  AnimatedSwitcher(
                    duration: const Duration(milliseconds: 220),
                    child: _tab == 1
                        ? _buildEmail(context)
                        : _codeStep
                            ? _buildCodeStep(context)
                            : _buildPhoneStep(context),
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
    final limit = _limitText();
    final error = _phoneErrorText();
    return Column(
      key: const ValueKey('phone'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(tr(ref, 'We\'ll text you a one-time code.', 'हम आपको एक बार का कोड SMS से भेजेंगे।'),
            textAlign: TextAlign.center, style: TextStyle(color: c.muted, fontSize: 14)),
        const SizedBox(height: 20),
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
                child: Text('+91', style: dataStyle(context, size: 15, weight: FontWeight.w700)),
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: TextField(
                key: const Key('phone-field'),
                controller: _phone,
                keyboardType: TextInputType.phone,
                textInputAction: TextInputAction.done,
                autofillHints: const [AutofillHints.telephoneNumberNational],
                inputFormatters: [
                  FilteringTextInputFormatter.digitsOnly,
                  LengthLimitingTextInputFormatter(10),
                ],
                style: dataStyle(context, size: 17, weight: FontWeight.w700),
                decoration: InputDecoration(
                  hintText: tr(ref, 'Mobile number', 'मोबाइल नंबर'),
                  counterText: '',
                ),
                onSubmitted: (_) => _requestCode(),
              ),
            ),
          ],
        ),
        if (_digits.length == 10 && !_validPhone)
          _Notice(text: friendlyError('invalid_phone', hi: ref.watch(langProvider) == 'hi')),
        if (limit != null) _Notice(text: limit, limit: true),
        if (error != null) _Notice(text: error),
        const SizedBox(height: 16),
        FilledButton(
          onPressed: canSend ? _requestCode : null,
          child: _busy
              ? const _Spinner()
              : Text(_blocked
                  ? tr(ref, 'Try again in ${_waitText(_blockLeft)}', '${_waitText(_blockLeft)} में फिर कोशिश करें')
                  : tr(ref, 'Get OTP', 'OTP पाएँ')),
        ),
      ],
    );
  }

  Widget _buildCodeStep(BuildContext context) {
    final c = context.colors;
    final resendLabel = _blocked
        ? tr(ref, 'Try again in ${_waitText(_blockLeft)}', '${_waitText(_blockLeft)} में फिर कोशिश करें')
        : _cooldown > 0
            ? tr(ref, 'Resend OTP in ${_cooldown}s', '$_cooldown सेकंड में OTP दोबारा भेजें')
            : tr(ref, 'Resend OTP', 'OTP दोबारा भेजें');
    final limit = _limitText();
    final error = _phoneErrorText();
    return Column(
      key: const ValueKey('code'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton.icon(
            onPressed: _busy ? null : _changeNumber,
            icon: const Icon(Icons.chevron_left_rounded),
            label: Text(tr(ref, 'Change number', 'नंबर बदलें')),
            style: TextButton.styleFrom(
              foregroundColor: c.ink,
              minimumSize: const Size(44, 44),
              padding: const EdgeInsets.only(right: 12),
            ),
          ),
        ),
        const SizedBox(height: 8),
        Text(tr(ref, 'Enter the OTP', 'OTP डालें'),
            style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontSize: 23)),
        const SizedBox(height: 6),
        Text(tr(ref, 'We sent an OTP to +91 $_digits', '+91 $_digits पर OTP भेजा गया'),
            style: TextStyle(color: c.muted, fontSize: 14)),
        const SizedBox(height: 22),
        _CodeBoxes(
          controller: _code,
          focusNode: _codeFocus,
          label: tr(ref, 'Enter 6-digit OTP', '6 अंकों का OTP डालें'),
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
                text: tr(ref, 'Test mode: your code is ', 'टेस्ट मोड: आपका कोड है '),
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
        if (limit != null) _Notice(text: limit, limit: true),
        if (error != null) _Notice(text: error),
        const SizedBox(height: 16),
        FilledButton(
          onPressed: !_busy && _code.text.length == _codeLen ? _verify : null,
          child: _busy
              ? const _Spinner()
              : Text(tr(ref, 'Verify & continue', 'जाँचें और आगे बढ़ें')),
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

  Widget _buildEmail(BuildContext context) {
    final c = context.colors;
    final error = _emailErrorText();
    final canSubmit = _validEmail && _password.text.isNotEmpty && !_busy;
    return Column(
      key: const ValueKey('email'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          tr(ref, 'Use the email and one-time password Deligro ops gave you.',
              'Deligro ऑप्स से मिला ईमेल और एक बार का पासवर्ड इस्तेमाल करें।'),
          textAlign: TextAlign.center,
          style: TextStyle(color: c.muted, fontSize: 14),
        ),
        const SizedBox(height: 20),
        TextField(
          key: const Key('email-field'),
          controller: _email,
          keyboardType: TextInputType.emailAddress,
          textInputAction: TextInputAction.next,
          autocorrect: false,
          enableSuggestions: false,
          autofillHints: const [AutofillHints.username, AutofillHints.email],
          decoration: InputDecoration(labelText: tr(ref, 'Email', 'ईमेल')),
        ),
        const SizedBox(height: 12),
        TextField(
          key: const Key('password-field'),
          controller: _password,
          obscureText: !_showPassword,
          textInputAction: TextInputAction.done,
          autocorrect: false,
          enableSuggestions: false,
          autofillHints: const [AutofillHints.password],
          decoration: InputDecoration(
            labelText: tr(ref, 'Password', 'पासवर्ड'),
            suffixIcon: IconButton(
              tooltip: _showPassword
                  ? tr(ref, 'Hide password', 'पासवर्ड छिपाएँ')
                  : tr(ref, 'Show password', 'पासवर्ड दिखाएँ'),
              onPressed: () => setState(() => _showPassword = !_showPassword),
              icon: Icon(_showPassword ? Icons.visibility_off_rounded : Icons.visibility_rounded),
            ),
          ),
          onSubmitted: (_) => _signInWithEmail(),
        ),
        if (error != null) _Notice(text: error),
        const SizedBox(height: 16),
        FilledButton(
          key: const Key('email-submit'),
          onPressed: canSubmit ? _signInWithEmail : null,
          child: _busy ? const _Spinner() : Text(tr(ref, 'Sign in', 'साइन इन करें')),
        ),
      ],
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
          width: 72,
          height: 72,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(18),
            boxShadow: const [
              BoxShadow(color: Color(0x59E69A02), blurRadius: 24, offset: Offset(0, 8)),
            ],
          ),
          child: Image.asset('assets/brand/mark.png', width: 72, height: 72),
        ),
        const SizedBox(height: 12),
        Semantics(
          header: true,
          label: 'Deligro Rider',
          excludeSemantics: true,
          child: Text.rich(
            TextSpan(
              text: 'Deligro',
              style: TextStyle(
                fontSize: 32,
                fontWeight: FontWeight.w900,
                letterSpacing: -1.2,
                color: c.ink,
              ),
              children: [
                TextSpan(text: '.', style: TextStyle(color: c.accent)),
                TextSpan(
                  text: ' Rider',
                  style: TextStyle(
                    fontSize: 20,
                    fontWeight: FontWeight.w700,
                    letterSpacing: -0.4,
                    color: c.muted,
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 4),
        Text(tr(ref, 'Sign in to start delivering', 'डिलीवरी शुरू करने के लिए साइन इन करें'),
            textAlign: TextAlign.center,
            style: TextStyle(color: c.muted, fontSize: 14, fontWeight: FontWeight.w500)),
      ],
    );
  }
}

/// The two sign-in methods as a pair of equal buttons.
class _Tabs extends StatelessWidget {
  const _Tabs({required this.index, required this.labels, required this.onChanged});

  final int index;
  final List<String> labels;
  final ValueChanged<int>? onChanged;

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
          for (var i = 0; i < labels.length; i++)
            Expanded(
              child: Semantics(
                button: true,
                selected: i == index,
                child: InkWell(
                  key: Key(i == 0 ? 'tab-phone' : 'tab-email'),
                  borderRadius: BorderRadius.circular(radiusBlock - 4),
                  onTap: onChanged == null ? null : () => onChanged!(i),
                  child: AnimatedContainer(
                    duration: const Duration(milliseconds: 160),
                    constraints: const BoxConstraints(minHeight: 44),
                    alignment: Alignment.center,
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
                    decoration: BoxDecoration(
                      color: i == index ? c.surface : Colors.transparent,
                      borderRadius: BorderRadius.circular(radiusBlock - 4),
                      border: i == index ? Border.all(color: c.line) : null,
                    ),
                    child: Text(
                      labels[i],
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        fontSize: 14,
                        fontWeight: i == index ? FontWeight.w800 : FontWeight.w600,
                        color: i == index ? c.ink : c.muted,
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

/// Six boxes over one invisible field, so paste and SMS autofill still work.
class _CodeBoxes extends StatelessWidget {
  const _CodeBoxes({
    required this.controller,
    required this.focusNode,
    required this.label,
    required this.onChanged,
  });

  final TextEditingController controller;
  final FocusNode focusNode;
  final String label;
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
              key: const Key('code-field'),
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

/// An error (or, with [limit], a rate-limit warning) under the form.
class _Notice extends StatelessWidget {
  const _Notice({required this.text, this.limit = false});

  final String text;
  final bool limit;

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
          border: limit ? Border.all(color: c.deal.withValues(alpha: .4)) : null,
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (limit) ...[
              Icon(Icons.warning_amber_rounded, size: 18, color: c.deal),
              const SizedBox(width: 8),
            ],
            Expanded(
              child: Text(
                text,
                textAlign: limit ? TextAlign.left : TextAlign.center,
                style: TextStyle(
                  color: c.deal,
                  fontSize: 13.5,
                  fontWeight: limit ? FontWeight.w700 : FontWeight.w500,
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
