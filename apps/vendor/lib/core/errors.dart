/// Vendor-facing copy for the `error` codes the website's API returns. Routes that write their own `message` take precedence
/// (ApiException).
String friendlyError(String code) {
  return switch (code) {
    'network' => 'No connection. Check your internet and try again.',
    'unauthenticated' || 'unauthorized' => 'Please sign in again.',
    'forbidden' => 'This account can\'t open the Partner app.',
    'no_restaurant' => 'This account doesn\'t run a shop on Deligro.',
    'rate_limited' || 'too_many' => 'Too many tries. Please wait a few minutes.',
    'bad_credentials' => 'Wrong mobile number or password. If you have never set a password, sign in with OTP.',
    'bad_request' || 'invalid_input' => 'Check what you entered and try again.',
    'cooldown' => 'Please wait a few seconds before asking for another code.',
    'daily_limit' => 'You have reached today\'s limit for login codes.',
    'invalid_phone' => 'Enter a valid 10-digit Indian mobile number.',
    'invalid' => 'That code is not right. Check it and try again.',
    'expired' => 'That code has expired. Ask for a new one.',
    'locked' => 'Too many wrong tries. Ask for a new code.',
    'no_code' => 'Ask for a code first.',
    'sms_unavailable' => 'We could not send the SMS right now. Try again shortly.',
    'file_too_large' => 'That file is larger than 2 MB. Split it into smaller sheets.',
    'feature_disabled' => 'Deligro has switched this off for your shop.',
    'invalid_transition' => 'This order has already moved on. Pull down to refresh.',
    'needs_migration' => 'This needs a Deligro update that isn\'t live yet. Try again later.',
    'name_required' => 'Enter a name.',
    'name_too_long' => 'That name is too long.',
    'invalid_price' => 'Enter the price in whole rupees.',
    'invalid_stockQty' || 'invalid_lowStockAt' => 'Enter stock as a whole number (0 or more).',
    'invalid_days' ||
    'invalid_schedule' ||
    'invalid_availableFrom' ||
    'invalid_availableTo' => 'Check the days and times this item is available.',
    'invalid_variant' => 'Each size needs a name and a price.',
    'invalid_group' ||
    'invalid_addon' => 'Each add-on group needs a name, at least one add-on, and a sensible min/max.',
    'too_many_variants' => 'At most 20 sizes per item.',
    'too_many_groups' => 'At most 10 add-on groups per item.',
    'invalid_image' => 'That photo couldn\'t be used. Try another.',
    'invalid_hours' => 'Set both opening and closing time (they can\'t be the same).',
    'invalid_weekly_off' => 'Pick at most six weekly off days.',
    'no_fulfilment' => 'Keep delivery or self-pickup on.',
    'invalid_pincode' => 'Enter a 6-digit pincode.',
    'invalid_address' || 'invalid_location' => 'Set the shop address and map location.',
    'invalid_dates' => 'Check the dates: the end can\'t be before the start.',
    'in_the_past' => 'That date has already passed.',
    'too_many_holidays' => 'You already have 30 upcoming holidays.',
    'invalid_close_for' => 'Choose how long to close for.',
    'nothing_to_change' => 'Nothing has changed.',
    'not_found' => 'We couldn\'t find that.',
    'not_configured' || 'backend_not_configured' => 'The server isn\'t set up yet.',
    _ => 'Something went wrong. Please try again.',
  };
}
