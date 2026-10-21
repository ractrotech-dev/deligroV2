import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/i18n.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';

/// Signed in, but this account runs no shop on Deligro (a customer, or a shop
/// not yet linked to this login). Says so and offers the way out.
class NoShopScreen extends ConsumerWidget {
  const NoShopScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.storefront_outlined, size: 48, color: c.muted),
                const SizedBox(height: 14),
                Text(
                  tr(ref, 'No shop on this account', 'इस अकाउंट पर कोई दुकान नहीं'),
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                const SizedBox(height: 8),
                Text(
                  tr(
                    ref,
                    'This login doesn\'t run a shop on Deligro. If you are a partner, sign in with the mobile number Deligro registered your shop with, or contact Deligro support.',
                    'यह लॉगिन Deligro पर कोई दुकान नहीं चलाता। अगर आप पार्टनर हैं, तो उसी मोबाइल नंबर से साइन इन करें जिससे Deligro ने आपकी दुकान रजिस्टर की थी, या Deligro सपोर्ट से संपर्क करें।',
                  ),
                  textAlign: TextAlign.center,
                  style: TextStyle(color: c.muted, height: 1.45),
                ),
                const SizedBox(height: 22),
                FilledButton(
                  onPressed: () => ref.read(authRepoProvider).signOut(),
                  child: Text(tr(ref, 'Sign out', 'साइन आउट')),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
