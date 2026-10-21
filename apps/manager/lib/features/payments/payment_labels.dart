import 'package:flutter/material.dart';

import '../../models/outcome.dart';
import '../../models/payment_request.dart';
import '../../theme/app_theme.dart';

/// What a payment refusal means, in words.
String paymentRefusalText(Refused<Object?> r) => switch (r.code) {
      'same_person' => 'You asked for this payment, so someone else has to approve it.',
      'already_decided' => 'Already decided by someone else. Showing the latest.',
      'nothing_to_pay' => 'There is nothing to pay for that period.',
      'duplicate_pending' => 'This rider already has a payout waiting for approval.',
      'reference_required' => 'Enter the bank or UPI reference of the payment.',
      'note_required' => 'Say why — a note is needed to reject.',
      'permission_denied' || 'forbidden' => "You don't have permission for that. Ask an admin.",
      'not_found' => "This isn't in your zones.",
      'rate_limited' => 'Too many changes at once. Wait a moment and try again.',
      _ => "That didn't go through (${r.code}).",
    };

Color paymentStatusColor(AppColors c, PaymentStatus s) => switch (s) {
      PaymentStatus.pendingApproval => c.amberText,
      PaymentStatus.approved => c.green,
      PaymentStatus.rejected => c.deal,
      PaymentStatus.cancelled || PaymentStatus.unknown => c.muted,
    };
