import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../core/document_file.dart';
import '../../core/money.dart';
import '../../core/navigation_launcher.dart';
import '../../models/profile.dart';
import '../../state/profile.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../../widgets/rows.dart';
import 'document_upload_screen.dart';
import 'document_viewer_screen.dart';
import 'documents_screen.dart';
import 'edit_sheets.dart';
import 'payout_account_sheet.dart';
import 'profile_widgets.dart';

/// Profile & documents, under More. The tab bar stays under every page.
final profileRoute = GoRoute(
  path: 'profile',
  builder: (_, _) => const ProfileScreen(),
  routes: [
    GoRoute(
      path: 'documents',
      builder: (_, _) => const DocumentsScreen(),
      routes: [
        GoRoute(
          path: 'upload/:type',
          builder: (_, state) => DocumentUploadScreen(type: state.pathParameters['type']!),
        ),
        GoRoute(
          path: 'view/:id',
          builder: (_, state) => DocumentViewerScreen(
            id: state.pathParameters['id']!,
            title: state.extra is String ? state.extra! as String : 'Document',
          ),
        ),
      ],
    ),
  ],
);

/// One line of "what is left to do" under the verification status.
typedef Reason = ({String text, ChipTone tone});

/// What stands between the rider and being verified, in plain words: what
/// they have to do first, then what only Deligro can do.
List<Reason> verificationReasons(RiderProfile p) {
  final check = p.check;
  String labels(List<String> types) => types.map(docTypeLabel).join(', ');
  final out = <Reason>[];
  if (check.missing.isNotEmpty) {
    out.add((text: 'Upload your ${labels(check.missing)}.', tone: ChipTone.bad));
  }
  for (final type in check.rejected) {
    final doc = p.documentOf(type);
    final remark = doc?.remarks?.trim().replaceFirst(RegExp(r'[.!]+$'), '');
    final why = remark == null || remark.isEmpty ? '' : ': $remark';
    out.add((text: '${docTypeLabel(type)} was rejected$why. Upload it again.', tone: ChipTone.bad));
  }
  for (final type in check.expired) {
    out.add((text: '${docTypeLabel(type)} has expired. Upload a new one.', tone: ChipTone.bad));
  }
  for (final d in p.documents) {
    if (d.expiringSoon && !check.rejected.contains(d.type)) {
      final days = d.daysLeft!;
      out.add((
        text: '${docTypeLabel(d.type)} ${days == 0 ? 'expires today' : 'expires in $days ${days == 1 ? 'day' : 'days'}'}.',
        tone: ChipTone.warn,
      ));
    }
  }
  if (check.awaitingReview.isNotEmpty) {
    out.add((text: '${labels(check.awaitingReview)}: waiting for Deligro to check.', tone: ChipTone.quiet));
  }
  return out;
}

class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final profile = ref.watch(riderProfileProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Profile & documents')),
      body: SafeArea(
        bottom: false,
        child: RefreshIndicator(
          onRefresh: () async {
            refreshProfile(ref);
            await ref.read(riderProfileProvider.future).then<void>((_) {}, onError: (_) {});
          },
          child: AsyncBody<RiderProfile>(
            value: profile,
            onRetry: () => ref.invalidate(riderProfileProvider),
            builder: (p) => _ProfileBody(profile: p),
          ),
        ),
      ),
    );
  }
}

class _ProfileBody extends ConsumerWidget {
  const _ProfileBody({required this.profile});

  final RiderProfile profile;

  Future<void> _after(BuildContext context, WidgetRef ref, Future<String?> sheet) async {
    final message = await sheet;
    if (message == null) return;
    refreshProfile(ref);
    if (context.mounted) showSnack(context, message);
  }

  Future<void> _changePhoto(BuildContext context, WidgetRef ref) async {
    final camera = await showModalBottomSheet<bool>(
      context: context,
      useRootNavigator: true,
      builder: (sheet) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              key: const Key('avatar-camera'),
              leading: const Icon(Icons.photo_camera_outlined),
              title: const Text('Take a photo'),
              onTap: () => Navigator.pop(sheet, true),
            ),
            ListTile(
              key: const Key('avatar-gallery'),
              leading: const Icon(Icons.photo_library_outlined),
              title: const Text('Choose from gallery'),
              onTap: () => Navigator.pop(sheet, false),
            ),
          ],
        ),
      ),
    );
    if (camera == null) return;
    final File? photo;
    try {
      photo = await ref.read(avatarChooserProvider)(camera: camera);
    } catch (_) {
      if (context.mounted) showSnack(context, 'Could not open the ${camera ? 'camera' : 'gallery'}.');
      return;
    }
    if (photo == null) return;
    try {
      await ref.read(profileRepoProvider).uploadAvatar(photo);
      refreshProfile(ref);
      if (context.mounted) showSnack(context, 'Photo updated.');
    } on ApiException catch (e) {
      if (context.mounted) showSnack(context, e.friendly);
    } finally {
      await deleteQuietly(photo.path);
    }
  }

  Future<void> _call(BuildContext context, WidgetRef ref, String? phone) async {
    final uri = callUri(phone);
    final opened = uri != null && await ref.read(urlOpenerProvider)(uri);
    if (!opened && context.mounted) showSnack(context, 'Could not open the phone app.');
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = profile;
    final c = context.colors;
    final repo = ref.read(profileRepoProvider);
    final editable = ref.watch(meProvider).value?.feature(profileEditFeature) ?? true;
    final decided = ref.watch(changeRequestsProvider).value?.where((r) => r.status != 'pending').take(3).toList() ??
        const <ChangeRequestView>[];
    final reasons = verificationReasons(p);
    final owner = p.vehicle.owner == 'rider' ? 'My own vehicle' : "Deligro's vehicle";
    final docsDone = p.check.required.length - p.check.missing.length;

    VoidCallback? edit(String field, VoidCallback open) => !editable || p.pendingFor(field) != null ? null : open;

    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
      children: [
        _Header(profile: p, onPhoto: editable ? () => _changePhoto(context, ref) : null),
        if (!editable) ...[
          const SizedBox(height: 12),
          Panel(
            key: const Key('editing-off'),
            child: Row(
              children: [
                Icon(Icons.lock_outline_rounded, color: c.muted),
                const SizedBox(width: 12),
                const Expanded(child: Text('Editing is turned off for your account. You can still see everything here.')),
              ],
            ),
          ),
        ],
        const SizedBox(height: 14),
        _VerificationCard(profile: p, reasons: reasons),
        const RowsLabel('Personal'),
        RowsCard(
          children: [
            InfoRow(
              rowKey: 'name',
              label: 'Name',
              value: p.name,
              pending: p.pendingFor('full_name'),
              onEdit: edit('full_name', () => _after(context, ref, showNameSheet(context, repo, p))),
            ),
            InfoRow(
              rowKey: 'phone',
              label: 'Phone (your sign-in number)',
              value: p.phone,
              editLabel: 'Change',
              onEdit: editable ? () => _after(context, ref, showPhoneSheet(context, repo)) : null,
            ),
            InfoRow(rowKey: 'rider-id', label: 'Rider ID', value: p.riderCode, mono: true),
            InfoRow(
              rowKey: 'address',
              label: 'Address',
              value: p.address.isEmpty ? null : p.address.oneLine,
              emptyText: 'Not added yet',
              onEdit: editable ? () => _after(context, ref, showAddressSheet(context, repo, p)) : null,
            ),
          ],
        ),
        const RowsLabel('Vehicle and licence'),
        RowsCard(
          children: [
            InfoRow(
              rowKey: 'vehicle',
              label: 'Vehicle',
              value: p.vehicle.type == null
                  ? null
                  : [
                      vehicleTypeLabels[p.vehicle.type] ?? p.vehicle.type!,
                      owner,
                      if (p.vehicle.registration != null) p.vehicle.registration!,
                    ].join(' · '),
              emptyText: 'Not added yet',
              pending: p.pendingFor('vehicle'),
              onEdit: edit('vehicle', () => _after(context, ref, showVehicleSheet(context, repo, p))),
            ),
            InfoRow(
              rowKey: 'licence',
              label: 'Driving licence',
              value: p.licence.number,
              mono: true,
              emptyText: 'Not added yet',
              note: p.licence.expiresOn == null ? null : 'Valid until ${formatDay(p.licence.expiresOn)}',
              noteBad: p.licence.expiresOn != null && p.licence.expiresOn!.compareTo(istDayKey(DateTime.now())) < 0,
              pending: p.pendingFor('licence'),
              onEdit: edit('licence', () => _after(context, ref, showLicenceSheet(context, repo, p))),
            ),
          ],
        ),
        const RowsLabel('Emergency contact'),
        RowsCard(
          children: [
            InfoRow(
              rowKey: 'emergency',
              label: p.emergency.relation ?? 'Contact',
              value: p.emergency.name,
              note: p.emergency.phone,
              emptyText: 'Not added yet',
              extra: p.emergency.phone == null
                  ? null
                  : OutlinedButton.icon(
                      key: const Key('call-emergency'),
                      onPressed: () => _call(context, ref, p.emergency.phone),
                      icon: const Icon(Icons.call_rounded, size: 18),
                      label: const Text('Call'),
                    ),
              onEdit: editable ? () => _after(context, ref, showEmergencySheet(context, repo, p)) : null,
            ),
          ],
        ),
        const RowsLabel('Payout account'),
        RowsCard(
          children: [
            InfoRow(
              rowKey: 'payout',
              label: p.payoutAccount?.kindLabel ?? 'Payout account',
              value: p.payoutAccount?.masked,
              mono: true,
              emptyText: 'Not added yet',
              pending: p.pendingFor('payout_account'),
              editLabel: p.payoutAccount == null ? 'Add' : 'Change',
              onEdit: edit('payout_account', () => _after(context, ref, showPayoutAccountSheet(context, repo, p))),
            ),
          ],
        ),
        const RowsLabel('Documents'),
        RowsCard(
          children: [
            NavRow(
              key: const Key('row-documents'),
              icon: Icons.folder_open_outlined,
              title: 'Documents',
              subtitle: '$docsDone of ${p.check.required.length} required uploaded',
              trailing: p.check.riderToDo
                  ? Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Container(
                          key: const Key('documents-dot'),
                          width: 10,
                          height: 10,
                          decoration: BoxDecoration(color: c.deal, shape: BoxShape.circle),
                        ),
                        Icon(Icons.chevron_right_rounded, color: c.muted),
                      ],
                    )
                  : null,
              onTap: () => context.push('/more/profile/documents'),
            ),
          ],
        ),
        if (decided.isNotEmpty) ...[
          const RowsLabel('Answers from Deligro'),
          Panel(
            key: const Key('decisions'),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final r in decided)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: Text(
                      '${changeFieldLabels[r.field] ?? r.field} change ${r.status == 'approved' ? 'approved' : 'declined'}'
                      '${r.decisionNote == null ? '.' : ': ${r.decisionNote}'}',
                      style: TextStyle(color: r.status == 'approved' ? c.green : c.deal, height: 1.35),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ],
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.profile, required this.onPhoto});

  final RiderProfile profile;
  final VoidCallback? onPhoto;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final name = (profile.name ?? '').trim();
    final initial = name.isEmpty ? '' : name.characters.first.toUpperCase();
    return Panel(
      child: Row(
        children: [
          InkWell(
            key: const Key('avatar-edit'),
            onTap: onPhoto,
            customBorder: const CircleBorder(),
            child: Stack(
              clipBehavior: Clip.none,
              children: [
                SizedBox(
                  width: 68,
                  height: 68,
                  child: NetImage(
                    url: profile.avatarUrl,
                    radius: 34,
                    fallback: Text(
                      initial,
                      style: TextStyle(color: c.onAccent, fontSize: 28, fontWeight: FontWeight.w800),
                    ),
                  ),
                ),
                if (onPhoto != null)
                  Positioned(
                    right: -2,
                    bottom: -2,
                    child: Container(
                      padding: const EdgeInsets.all(5),
                      decoration: BoxDecoration(
                        color: c.surface,
                        shape: BoxShape.circle,
                        border: Border.all(color: c.line),
                      ),
                      child: Icon(Icons.photo_camera_rounded, size: 15, color: c.ink),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (name.isNotEmpty)
                  Text(
                    name,
                    key: const Key('profile-name'),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                const SizedBox(height: 6),
                Wrap(
                  spacing: 8,
                  runSpacing: 6,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    if (profile.riderCode != null)
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                        decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(6)),
                        child: Text(profile.riderCode!, style: dataStyle(context, size: 13)),
                      ),
                    VerificationBadge(profile.verification),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _VerificationCard extends StatelessWidget {
  const _VerificationCard({required this.profile, required this.reasons});

  final RiderProfile profile;
  final List<Reason> reasons;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final todo = reasons.any((r) => r.tone != ChipTone.quiet);
    final (title, body, icon, color) = switch (profile.verification) {
      Verification.verified when !todo => ('You are verified', 'Deligro has checked your documents.', Icons.verified_rounded, c.green),
      Verification.verified => ('You are verified', 'Something needs your attention.', Icons.verified_rounded, c.green),
      Verification.pending => ('Waiting for Deligro', 'Deligro is checking what you sent.', Icons.hourglass_top_rounded, c.accentInk),
      Verification.rejected => ('Deligro needs more from you', 'Fix the items below and send them again.', Icons.error_outline_rounded, c.deal),
      Verification.unverified => ('Not verified yet', 'Upload your documents so Deligro can verify you.', Icons.shield_outlined, c.muted),
    };
    return Panel(
      key: const Key('verification-card'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, color: color),
              const SizedBox(width: 10),
              Expanded(child: Text(title, style: Theme.of(context).textTheme.titleMedium)),
            ],
          ),
          const SizedBox(height: 4),
          Text(body, style: TextStyle(color: c.muted, height: 1.35)),
          if (reasons.isNotEmpty) ...[
            const SizedBox(height: 10),
            for (final r in reasons)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Padding(
                      padding: const EdgeInsets.only(top: 6, right: 10),
                      child: Container(
                        width: 8,
                        height: 8,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: switch (r.tone) {
                            ChipTone.bad => c.deal,
                            ChipTone.warn => c.accent,
                            _ => c.muted,
                          },
                        ),
                      ),
                    ),
                    Expanded(child: Text(r.text, style: const TextStyle(height: 1.35))),
                  ],
                ),
              ),
          ],
          if (todo) ...[
            const SizedBox(height: 12),
            OutlinedButton(
              key: const Key('open-documents'),
              onPressed: () => context.push('/more/profile/documents'),
              child: const Text('Go to documents'),
            ),
          ],
        ],
      ),
    );
  }
}

/// A label, its value and one button; with a "Waiting for Deligro" note and
/// the button off while a request for this field is open.
class InfoRow extends StatelessWidget {
  const InfoRow({
    super.key,
    required this.rowKey,
    required this.label,
    required this.value,
    this.emptyText = '',
    this.note,
    this.noteBad = false,
    this.mono = false,
    this.pending,
    this.editLabel = 'Edit',
    this.onEdit,
    this.extra,
  });

  final String rowKey;
  final String label;
  final String? value;
  final String emptyText;
  final String? note;
  final bool noteBad;
  final bool mono;
  final PendingChange? pending;
  final String editLabel;

  /// Null turns the button off (read-only row, editing off, or a request open).
  final VoidCallback? onEdit;
  final Widget? extra;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final shown = (value ?? '').isEmpty ? emptyText : value!;
    final valueStyle = mono
        ? dataStyle(context, size: 15, weight: FontWeight.w700)
        : TextStyle(color: c.ink, fontSize: 16, fontWeight: FontWeight.w700, height: 1.3);
    return Padding(
      key: Key('info-$rowKey'),
      padding: const EdgeInsets.fromLTRB(16, 12, 8, 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label, style: TextStyle(color: c.muted, fontSize: 13)),
                const SizedBox(height: 2),
                Text(
                  shown,
                  key: Key('value-$rowKey'),
                  style: (value ?? '').isEmpty ? valueStyle.copyWith(color: c.muted, fontWeight: FontWeight.w500) : valueStyle,
                ),
                if (note != null) ...[
                  const SizedBox(height: 2),
                  Text(
                    note!,
                    key: Key('note-$rowKey'),
                    style: TextStyle(color: noteBad ? c.deal : c.muted, fontSize: 13, fontWeight: noteBad ? FontWeight.w700 : null),
                  ),
                ],
                if (pending != null) ...[
                  const SizedBox(height: 8),
                  Wrap(
                    key: Key('pending-$rowKey'),
                    spacing: 8,
                    runSpacing: 4,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      const StatusChip('Waiting for Deligro', tone: ChipTone.warn, icon: Icons.hourglass_top_rounded),
                      if (pending!.summary != null)
                        Text('Asked for: ${pending!.summary}', style: TextStyle(color: c.muted, fontSize: 13)),
                    ],
                  ),
                ],
                if (extra != null) ...[const SizedBox(height: 10), extra!],
              ],
            ),
          ),
          if (onEdit != null || pending != null)
            TextButton(
              key: Key('edit-$rowKey'),
              onPressed: onEdit,
              child: Text(editLabel),
            ),
        ],
      ),
    );
  }
}
