import 'package:flutter/material.dart';

import '../../models/customers.dart';
import '../../theme/app_theme.dart';

Color customerStatusColor(AppColors c, CustomerStatus s) => switch (s) {
      CustomerStatus.active => c.green,
      CustomerStatus.restricted => c.pop,
      CustomerStatus.suspended => c.deal,
      CustomerStatus.unknown => c.muted,
    };

String customerRefusal(String code) => switch (code) {
      'stale' => 'Someone else changed this account. Showing the latest.',
      'not_a_customer' => 'Only customer accounts can be changed here.',
      'reason_required' => 'Give a reason of at least 3 characters.',
      'permission_denied' || 'forbidden' => "You don't have permission for that.",
      'not_found' => "This customer isn't in your zones.",
      'rate_limited' => 'Too many requests. Wait a moment and try again.',
      _ => "That didn't go through ($code).",
    };
