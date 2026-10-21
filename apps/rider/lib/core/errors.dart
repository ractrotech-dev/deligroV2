/// Rider-facing copy for the `error` codes the website's API returns.
/// Routes that write their own `message` take precedence (ApiException).
///
/// [hi] picks the Hindi sentence for the codes a rider can meet (sign-in, the
/// gate, availability); any code without one reads in English.
String friendlyError(String code, {bool hi = false}) {
  if (hi) {
    final h = _hindi[code];
    if (h != null) return h;
  }
  if (code.startsWith('coupon_')) return couponError(code.substring(7));
  return switch (code) {
    'network' => 'No connection. Check your internet and try again.',
    'unauthorized' || 'unauthenticated' => 'Please sign in again.',
    // Rider routes (src/app/api/rider).
    'not_rider' => "This account isn't a Deligro rider. Ask Deligro ops to enable rider access.",
    'not_configured' => "Deligro's server is not set up yet. Please try again later.",
    'migration_pending' => 'This is not available yet. Please try again later.',
    'active_delivery' => 'Finish your current delivery first.',
    'not_online' => 'Go online first.',
    'invalid_minutes' => 'Choose a break of 15, 30 or 60 minutes.',
    'invalid_position' => 'We could not read your location.',
    'invalid_body' => 'Something went wrong. Please try again.',
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

const _hindi = <String, String>{
  'network': 'कनेक्शन नहीं है। इंटरनेट जाँचकर फिर कोशिश करें।',
  'unauthorized': 'कृपया फिर से साइन इन करें।',
  'unauthenticated': 'कृपया फिर से साइन इन करें।',
  'rate_limited': 'बहुत ज़्यादा कोशिशें। थोड़ा रुककर फिर करें।',
  'too_many': 'बहुत ज़्यादा कोशिशें। थोड़ा रुककर फिर करें।',
  'cooldown': 'दूसरा कोड माँगने से पहले कुछ सेकंड रुकें।',
  'daily_limit': 'आज के लॉगिन कोड की सीमा पूरी हो गई है।',
  'invalid_phone': '10 अंकों का सही भारतीय मोबाइल नंबर डालें।',
  'invalid': 'यह कोड सही नहीं है। जाँचकर फिर कोशिश करें।',
  'invalid_input': 'यह कोड सही नहीं है। जाँचकर फिर कोशिश करें।',
  'expired': 'यह कोड एक्सपायर हो गया है। नया कोड माँगें।',
  'locked': 'बहुत ज़्यादा गलत कोशिशें। नया कोड माँगें।',
  'no_code': 'पहले कोड माँगें।',
  'sms_unavailable': 'अभी SMS नहीं भेज पाए। थोड़ी देर में फिर कोशिश करें।',
  'not_rider': 'यह खाता Deligro राइडर का नहीं है। राइडर एक्सेस चालू कराने के लिए Deligro ऑप्स से कहें।',
  'not_configured': 'Deligro का सर्वर अभी तैयार नहीं है। बाद में फिर कोशिश करें।',
  'migration_pending': 'यह अभी उपलब्ध नहीं है। बाद में फिर कोशिश करें।',
  'active_delivery': 'पहले अपनी मौजूदा डिलीवरी पूरी करें।',
  'not_online': 'पहले ऑनलाइन हों।',
  'invalid_minutes': '15, 30 या 60 मिनट का ब्रेक चुनें।',
  'invalid_position': 'हम आपकी लोकेशन नहीं पढ़ पाए।',
};

String couponError(String reason) => switch (reason) {
      'empty' => 'Enter a promo code.',
      'invalid' => 'That promo code doesn\'t exist.',
      'expired' => 'That promo code has expired.',
      'min_order' => 'Add more items to use this code.',
      'wrong_restaurant' => 'This code is not valid at this restaurant.',
      'already_used' => 'You have already used this code.',
      'already_applied' => 'A code is already applied to this order.',
      'exhausted' => 'This code has run out.',
      _ => 'This promo code can\'t be used.',
    };
