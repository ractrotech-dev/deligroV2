import 'package:cross_file/cross_file.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:uuid/uuid.dart';

import '../../../core/api.dart';
import '../../../models/outcome.dart';
import '../../../models/vendors.dart';
import '../../../state/providers.dart';
import '../../../theme/app_theme.dart';
import '../../../widgets/async_view.dart';
import '../vendor_tabs.dart' show FactRow, InfoSection;

class StepTitle extends StatelessWidget {
  const StepTitle(this.title, this.subtitle, {super.key});
  final String title;
  final String subtitle;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 8, bottom: 16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: TextStyle(fontSize: 19, fontWeight: FontWeight.w800, color: context.colors.ink)),
            const SizedBox(height: 4),
            Text(subtitle, style: TextStyle(color: context.colors.muted, height: 1.35)),
          ],
        ),
      );
}

/// Where the manager is in the flow: one segment per step.
class StepDots extends StatelessWidget {
  const StepDots({super.key, required this.steps, required this.current});
  final List<String> steps;
  final int current;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              for (var i = 0; i < steps.length; i++) ...[
                Expanded(
                  child: Container(
                    height: 4,
                    decoration: BoxDecoration(
                      color: i <= current ? c.accent : c.line,
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                ),
                if (i < steps.length - 1) const SizedBox(width: 4),
              ],
            ],
          ),
          const SizedBox(height: 6),
          Text('Step ${current + 1} of ${steps.length} · ${steps[current]}',
              style: TextStyle(color: c.muted, fontSize: 12.5, fontWeight: FontWeight.w600)),
        ],
      ),
    );
  }
}

/// Everything about to be sent, in one place.
class OnboardReview extends StatelessWidget {
  const OnboardReview({super.key, required this.draft, required this.zoneName, required this.docs});
  final OnboardDraft draft;
  final String? zoneName;
  final List<DocType> docs;

  @override
  Widget build(BuildContext context) {
    final d = draft;
    String or(String? s, [String none = '—']) => s == null || s.trim().isEmpty ? none : s.trim();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const StepTitle('Check and add', 'The shop is created as Pending. Approve it once documents are verified.'),
        InfoSection(title: 'Shop', children: [
          FactRow('Name', d.shopName),
          FactRow('Zone', or(zoneName)),
          FactRow('Category', or(d.category)),
          FactRow('FSSAI number', or(d.fssaiNumber, 'Not given')),
          FactRow('Logo', d.logoUrl == null ? 'None' : 'Added'),
        ]),
        InfoSection(title: 'Owner', children: [
          FactRow('Name', d.ownerName),
          FactRow('Mobile', d.mobile, mono: true),
          if (d.altMobile != null && d.altMobile!.trim().isNotEmpty) FactRow('Alternate mobile', d.altMobile!.trim(), mono: true),
          FactRow('Email', d.email),
          FactRow('Password', d.password == null || d.password!.isEmpty ? 'Deligro makes one' : 'Set by you'),
        ]),
        InfoSection(title: 'Location', children: [
          FactRow('Address', d.address),
          if (d.landmark != null && d.landmark!.isNotEmpty) FactRow('Landmark', d.landmark!),
          if (d.pincode != null && d.pincode!.isNotEmpty) FactRow('Pincode', d.pincode!, mono: true),
          FactRow('Map pin', d.lat == null ? 'Not pinned' : 'Pinned'),
        ]),
        InfoSection(title: 'Hours', children: [
          FactRow('Hours', d.openingTime == null ? 'Not set' : '${d.openingTime} – ${d.closingTime}', mono: true),
          FactRow('Weekly off', d.weeklyOff.isEmpty ? 'None' : d.weeklyOff.join(', ')),
          FactRow('Delivery / pickup', '${d.deliveryAvailable ? 'Delivery' : 'No delivery'} · ${d.selfPickup ? 'Pickup' : 'No pickup'}'),
        ]),
        InfoSection(title: 'Documents', children: [
          Text(docs.isEmpty ? 'None added — they can be uploaded later.' : docs.map((t) => t.label).join(', ')),
        ]),
      ],
    );
  }
}

enum _Up { waiting, sending, done, failed }

/// After the shop is created: the generated sign-in (shown once), then each
/// chosen document uploaded in turn, each with its own Retry.
class OnboardDone extends ConsumerStatefulWidget {
  const OnboardDone({
    super.key,
    required this.result,
    required this.shopName,
    required this.docs,
    this.passwordTyped = false,
  });
  final OnboardResult result;
  final String shopName;
  final Map<DocType, XFile> docs;

  /// The manager set the password, so none comes back.
  final bool passwordTyped;

  @override
  ConsumerState<OnboardDone> createState() => _OnboardDoneState();
}

class _OnboardDoneState extends ConsumerState<OnboardDone> {
  late final Map<DocType, _Up> _state = {for (final t in widget.docs.keys) t: _Up.waiting};

  /// One id per file, kept across retries: a retry is the same upload.
  late final Map<DocType, String> _ids = {for (final t in widget.docs.keys) t: const Uuid().v4()};

  @override
  void initState() {
    super.initState();
    _uploadAll();
  }

  Future<void> _uploadAll() async {
    for (final t in widget.docs.keys) {
      if (_state[t] == _Up.waiting) await _upload(t);
    }
  }

  Future<void> _upload(DocType t) async {
    setState(() => _state[t] = _Up.sending);
    try {
      final out = await ref.read(vendorsRepoProvider).upload(widget.result.id, t.wire, widget.docs[t]!, _ids[t]!);
      if (!mounted) return;
      setState(() => _state[t] = out is Applied ? _Up.done : _Up.failed);
    } on ApiException {
      if (mounted) setState(() => _state[t] = _Up.failed);
    }
  }

  Future<void> _copy(String text, String what) async {
    await Clipboard.setData(ClipboardData(text: text));
    if (mounted) showSnack(context, '$what copied.');
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final r = widget.result;
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
      children: [
        Icon(Icons.check_circle_rounded, color: c.green, size: 40),
        const SizedBox(height: 8),
        Text('${widget.shopName} is added as Pending.',
            style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: c.ink)),
        const SizedBox(height: 4),
        Text('Verify its documents and approve it from the vendor screen.', style: TextStyle(color: c.muted)),
        if (r.hasCredentials)
          InfoSection(title: 'Sign-in for the owner', children: [
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(color: c.dealSoft, borderRadius: BorderRadius.circular(radiusBlock)),
              child: Text(
                'Give these to the owner now. The password will not be shown again.',
                style: TextStyle(color: c.ink, fontWeight: FontWeight.w600),
              ),
            ),
            const SizedBox(height: 8),
            _credential('Email', r.email ?? '', 'copy-email'),
            _credential('Password', r.password!, 'copy-password'),
          ]),
        if (!r.hasCredentials)
          InfoSection(title: 'Sign-in for the owner', children: [
            Text(
              widget.passwordTyped
                  ? 'The owner signs in with their mobile or email and the password you set.'
                  : 'The sign-in details were shown once when this vendor was first added. '
                      'If they were lost, an admin can reset the password.',
              style: TextStyle(color: c.ink, height: 1.4),
            ),
          ]),
        if (widget.docs.isNotEmpty)
          InfoSection(title: 'Documents', children: [
            for (final t in widget.docs.keys)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Row(
                  children: [
                    Icon(
                      switch (_state[t]!) {
                        _Up.done => Icons.check_circle_outline,
                        _Up.failed => Icons.error_outline,
                        _ => Icons.upload_outlined,
                      },
                      color: switch (_state[t]!) {
                        _Up.done => c.green,
                        _Up.failed => c.deal,
                        _ => c.muted,
                      },
                      size: 20,
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        '${t.label} · ${switch (_state[t]!) {
                          _Up.waiting => 'waiting',
                          _Up.sending => 'uploading…',
                          _Up.done => 'uploaded',
                          _Up.failed => "didn't upload",
                        }}',
                      ),
                    ),
                    if (_state[t] == _Up.failed)
                      TextButton(key: Key('upload-retry-${t.wire}'), onPressed: () => _upload(t), child: const Text('Retry')),
                  ],
                ),
              ),
          ]),
        const SizedBox(height: 24),
        FilledButton(
          key: const Key('onboard-open-vendor'),
          onPressed: () => GoRouter.maybeOf(context)?.pushReplacement('/more/vendors/${r.id}'),
          child: const Text('Open the vendor'),
        ),
      ],
    );
  }

  Widget _credential(String label, String value, String key) => Row(
        children: [
          Expanded(child: FactRow(label, value, mono: true)),
          IconButton(
            key: Key(key),
            tooltip: 'Copy $label',
            onPressed: () => _copy(value, label),
            icon: const Icon(Icons.copy_rounded, size: 18),
          ),
        ],
      );
}
