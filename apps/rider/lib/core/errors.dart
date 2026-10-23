/// Rider-facing copy for the `error` codes the website's API returns.
/// Routes that write their own `message` take precedence (ApiException).
String friendlyError(String code) {
  return switch (code) {
    'network' => 'No connection. Check your internet and try again.',
    'unauthorized' || 'unauthenticated' => 'Please sign in again.',
    // Rider routes (src/app/api/rider).
    'not_rider' => "This account isn't a Deligro rider. Ask Deligro support to turn on rider access.",
    'not_configured' => 'Deligro is not ready yet. Try again later.',
    'migration_pending' => 'This is not available yet. Please try again later.',
    'feature_disabled' => "This isn't turned on for your account.",
    'documents_expired' =>
      'Your documents have expired. Upload new ones in Profile & documents. You can take jobs again once Deligro has checked them.',
    'active_delivery' => 'Finish your current delivery first.',
    'not_online' => 'Go online first.',
    'invalid_minutes' => 'Choose a break of 15, 30 or 60 minutes.',
    'invalid_position' => 'We could not read your location.',
    'server_error' || 'invalid_body' || 'otp_misconfigured' =>
      'Something went wrong on our side. Please try again in a moment.',
    'backend_not_configured' => 'Deligro is not ready yet. Try again later.',
    'rate_limited' || 'too_many' => 'Too many tries. Please wait a moment.',
    'cooldown' => 'Please wait a few seconds before asking for another code.',
    'daily_limit' => 'You\'ve used up today\'s codes. Try again tomorrow.',
    'invalid_phone' => 'Enter a valid 10-digit Indian mobile number.',
    'invalid' || 'invalid_input' => 'That code is not right. Check it and try again.',
    'expired' => 'That code has expired. Ask for a new one.',
    'locked' => 'Too many wrong tries. Ask for a new code.',
    'no_code' => 'Ask for a code first.',
    'sms_unavailable' => 'We could not send the SMS right now. Please try again shortly.',
    'not_found' => 'We couldn\'t find that.',
    'invalid_name' => 'Enter your name (at least 2 characters).',
    'phone_taken' => 'That number is already used by another account.',
    'otp_invalid' => 'That code is not right.',
    // Profile and documents.
    'invalid_value' => 'Check what you entered and try again.',
    'duplicate_pending' => 'You already have a change waiting for Deligro.',
    'needs_approval' => 'Deligro has to approve this change. Send a change request.',
    'bad_type' => 'Use a PDF, JPEG or PNG file.',
    'invalid_type' => 'Use a JPEG or PNG photo.',
    'too_large' => 'That file is bigger than 4 MB.',
    'file_too_large' => 'That file is too large.',
    'photo_too_large' => 'This photo is too large. Take a new photo instead.',
    'pdf_too_large' => "That PDF is bigger than 4 MB. Use a smaller PDF, or take a photo of the document.",
    'cannot_shrink' => "We couldn't make this photo small enough. Take a new photo.",
    'invalid_number' => 'Check the document number.',
    'expiry_required' => 'Add the expiry date.',
    'invalid_expiry' => 'That date has already passed.',
    'otp_required' => 'Enter the code we sent you.',
    // Any 5xx the app could not name (`http_500`, `http_503`, ...).
    _ when code.startsWith('http_5') =>
      'Something went wrong on our side. Please try again in a moment.',
    _ => 'Something went wrong. Please try again.',
  };
}
