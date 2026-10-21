/// Customer-facing copy for the `error` codes the website's API returns.
/// Routes that write their own `message` take precedence (ApiException).
String friendlyError(String code) {
  if (code.startsWith('coupon_')) return couponError(code.substring(7));
  return switch (code) {
    'network' => 'No connection. Check your internet and try again.',
    'unauthorized' => 'Please sign in again.',
    'rate_limited' || 'too_many' => 'Too many tries. Please wait a moment.',
    'cooldown' => 'Please wait a few seconds before asking for another code.',
    'daily_limit' => 'You have reached today\'s limit for login codes.',
    'invalid_phone' => 'Enter a valid 10-digit Indian mobile number.',
    'invalid' || 'invalid_input' => 'That code is not right. Check it and try again.',
    'expired' => 'That code has expired. Ask for a new one.',
    'locked' => 'Too many wrong tries. Ask for a new code.',
    'no_code' => 'Ask for a code first.',
    'sms_unavailable' => 'We could not send the SMS right now. Please try again shortly.',
    'restaurant_not_found' => 'This restaurant is no longer available.',
    'restaurant_closed' => 'This restaurant has just closed. Try another one.',
    'empty_cart' => 'Your basket is empty.',
    'invalid_items' =>
      'Some items in your basket are no longer on the menu. Remove them and try again.',
    'not_a_customer' => 'This account cannot place customer orders.',
    'orders_paused' => 'Orders are paused right now. Please try again later.',
    'online_payments_unavailable' || 'payments_unavailable' =>
      'Online payment is not available right now. Choose cash on delivery.',
    'too_late' => 'The kitchen has already packed this order, so it can\'t be cancelled.',
    'not_found' => 'We couldn\'t find that.',
    'already_reviewed' => 'You have already rated this order.',
    'already_requested' => 'A refund has already been requested for this order.',
    'invalid_state' => 'A refund can\'t be requested for this order.',
    'invalid_address' => 'Enter a fuller address (at least 6 characters).',
    'invalid_name' => 'Enter your name (at least 2 characters).',
    'phone_taken' => 'That number is already used by another account.',
    'otp_invalid' => 'That code is not right.',
    'signature_mismatch' => 'We could not confirm the payment. If money was taken, it will be refunded.',
    _ => 'Something went wrong. Please try again.',
  };
}

String couponError(String reason) => switch (reason) {
      'empty' => 'Enter a promo code.',
      'invalid' => 'That promo code doesn\'t exist.',
      'expired' => 'That promo code has expired.',
      'not_started' => 'That offer hasn\'t started yet.',
      'min_order' => 'Add more items to use this code.',
      'wrong_restaurant' => 'This code is not valid at this restaurant.',
      'already_used' => 'You have already used this code.',
      'already_applied' => 'A code is already applied to this order.',
      'exhausted' => 'This code has run out.',
      _ => 'This promo code can\'t be used.',
    };
