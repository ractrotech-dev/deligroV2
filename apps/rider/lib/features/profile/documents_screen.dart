import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/money.dart';
import '../../models/profile.dart';
import '../../state/profile.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../../widgets/rows.dart';
import 'profile_widgets.dart';

/// The rider's documents by type: status, number (masked), expiry with days
/// left, and the way to upload, replace or view each one.
class DocumentsScreen extends ConsumerWidget {
  const DocumentsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final profile = ref.watch(riderProfileProvider(ref.watch(riderKeyProvider)));
    return Scaffold(
      appBar: AppBar(title: const Text('Documents')),
      body: SafeArea(
        bottom: false,
        child: RefreshIndicator(
          onRefresh: () async {
            refreshProfile(ref);
            await ref.read(riderProfileProvider(ref.read(riderKeyProvider)).future).then<void>((_) {}, onError: (_) {});
          },
          child: AsyncBody<RiderProfile>(
            value: profile,
            onRetry: () => ref.invalidate(riderProfileProvider),
            builder: (p) => _DocumentsBody(profile: p),
          ),
        ),
      ),
    );
  }
}

class _DocumentsBody extends ConsumerWidget {
  const _DocumentsBody({required this.profile});

  final RiderProfile profile;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final editable = ref.watch(currentMeProvider)?.feature(profileEditFeature) ?? true;
    final required = profile.check.required;
    final optional = [
      for (final t in docTypes)
        if (!required.contains(t.id) && (t.id == 'pan' || profile.documentOf(t.id) != null)) t.id,
    ];
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
      children: [
        Text(
          'Upload a clear photo, or a PDF up to 4 MB. Deligro checks each one before you are verified.',
          style: TextStyle(color: c.muted, height: 1.4),
        ),
        const RowsLabel('Needed to get verified'),
        for (final type in required) ...[
          _DocCard(type: type, doc: profile.documentOf(type), editable: editable),
          const SizedBox(height: 12),
        ],
        if (optional.isNotEmpty) ...[
          const RowsLabel('Optional'),
          for (final type in optional) ...[
            _DocCard(type: type, doc: profile.documentOf(type), editable: editable),
            const SizedBox(height: 12),
          ],
        ],
        if (profile.vehicle.owner != 'rider')
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              'Vehicle papers (RC, insurance, PUC) are only needed if you ride your own vehicle.',
              style: TextStyle(color: c.muted, fontSize: 13, height: 1.4),
            ),
          ),
      ],
    );
  }
}

class _DocCard extends StatelessWidget {
  const _DocCard({required this.type, required this.doc, required this.editable});

  final String type;
  final RiderDocument? doc;
  final bool editable;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final d = doc;
    final label = docTypeLabel(type);
    final status = d == null ? (label: 'Not uploaded', tone: ChipTone.warn) : docStatus(d);
    final expiry = d == null || d.expiresOn == null ? null : expiryLine(d, formatDay);
    final bad = d != null && (d.expired || d.rejected);
    return Container(
      key: Key('doc-$type'),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: c.surface,
        borderRadius: BorderRadius.circular(radiusBlock),
        border: Border.all(color: bad ? c.deal : c.line, width: bad ? 1.5 : 1),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TitleWithChip(
            title: Text(label, style: Theme.of(context).textTheme.titleMedium),
            chip: StatusChip(status.label, tone: status.tone, key: Key('status-$type')),
          ),
          if (d?.numberMasked != null) ...[
            const SizedBox(height: 6),
            Text(d!.numberMasked!, key: Key('number-$type'), style: dataStyle(context, size: 14)),
          ],
          if (expiry != null) ...[
            const SizedBox(height: 6),
            Text(
              expiry.text,
              key: Key('expiry-$type'),
              style: TextStyle(
                color: switch (expiry.tone) {
                  ChipTone.bad => c.deal,
                  ChipTone.warn => c.accentInk,
                  _ => c.muted,
                },
                fontWeight: expiry.tone == ChipTone.quiet ? FontWeight.w500 : FontWeight.w800,
                fontSize: 14,
              ),
            ),
          ],
          if (d != null && d.rejected && d.remarks != null) ...[
            const SizedBox(height: 6),
            Text(d.remarks!, key: Key('remarks-$type'), style: TextStyle(color: c.deal, height: 1.35)),
          ],
          if (d == null && type == 'photo') ...[
            const SizedBox(height: 6),
            Text('A clear photo of your face, in good light.', style: TextStyle(color: c.muted, height: 1.35)),
          ],
          const SizedBox(height: 12),
          Row(
            children: [
              if (d != null)
                Expanded(
                  child: OutlinedButton.icon(
                    key: Key('view-$type'),
                    onPressed: () => context.push('/more/profile/documents/view/${d.id}', extra: label),
                    icon: const Icon(Icons.visibility_outlined, size: 18),
                    label: const Text('View'),
                  ),
                ),
              if (d != null && editable) const SizedBox(width: 10),
              if (editable)
                Expanded(
                  child: d == null || bad
                      ? FilledButton(
                          key: Key('upload-$type'),
                          style: FilledButton.styleFrom(minimumSize: const Size(48, 48)),
                          onPressed: () => context.push('/more/profile/documents/upload/$type'),
                          child: Text(d == null ? 'Upload' : 'Upload again'),
                        )
                      : OutlinedButton.icon(
                          key: Key('upload-$type'),
                          onPressed: () => context.push('/more/profile/documents/upload/$type'),
                          icon: const Icon(Icons.upload_rounded, size: 18),
                          label: const Text('Replace'),
                        ),
                ),
            ],
          ),
        ],
      ),
    );
  }
}
