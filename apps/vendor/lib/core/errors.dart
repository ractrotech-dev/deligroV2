/// Vendor-facing copy for the `error` codes the website's API returns, in
/// English and Hindi. Routes that write their own `message` take precedence
/// (ApiException).
String friendlyError(String code, {bool hi = false}) {
  final (en, hin) = switch (code) {
    'network' => ('No connection. Check your internet and try again.', 'इंटरनेट नहीं है। कनेक्शन देखकर फिर कोशिश करें।'),
    'unauthenticated' || 'unauthorized' => ('Please sign in again.', 'कृपया फिर से साइन इन करें।'),
    'forbidden' => ('This account can\'t open the Partner app.', 'यह अकाउंट पार्टनर ऐप नहीं खोल सकता।'),
    'no_restaurant' => ('This account doesn\'t run a shop on Deligro.', 'यह अकाउंट Deligro पर कोई दुकान नहीं चलाता।'),
    'rate_limited' || 'too_many' => ('Too many tries. Please wait a few minutes.', 'बहुत बार कोशिश हुई। कुछ मिनट रुकें।'),
    'bad_credentials' => (
        'Wrong mobile number or password. If you have never set a password, sign in with OTP.',
        'मोबाइल नंबर या पासवर्ड गलत है। अगर पासवर्ड कभी नहीं बनाया, तो OTP से साइन इन करें।',
      ),
    'bad_request' || 'invalid_input' => ('Check what you entered and try again.', 'जो भरा है उसे जाँचकर फिर कोशिश करें।'),
    'cooldown' => ('Please wait a few seconds before asking for another code.', 'नया कोड माँगने से पहले कुछ सेकंड रुकें।'),
    'daily_limit' => ('You have reached today\'s limit for login codes.', 'आज के लॉगिन कोड की सीमा पूरी हो गई।'),
    'invalid_phone' => ('Enter a valid 10-digit Indian mobile number.', 'सही 10 अंकों का मोबाइल नंबर डालें।'),
    'invalid' => ('That code is not right. Check it and try again.', 'कोड सही नहीं है। जाँचकर फिर डालें।'),
    'expired' => ('That code has expired. Ask for a new one.', 'कोड की समय-सीमा खत्म हो गई। नया कोड माँगें।'),
    'locked' => ('Too many wrong tries. Ask for a new code.', 'बहुत बार गलत कोड डाला। नया कोड माँगें।'),
    'no_code' => ('Ask for a code first.', 'पहले कोड माँगें।'),
    'sms_unavailable' => ('We could not send the SMS right now. Try again shortly.', 'अभी SMS नहीं भेज पाए। थोड़ी देर में फिर कोशिश करें।'),
    'feature_disabled' => ('Deligro has switched this off for your shop.', 'Deligro ने आपकी दुकान के लिए यह बंद किया है।'),
    'invalid_transition' => ('This order has already moved on. Pull down to refresh.', 'यह ऑर्डर आगे बढ़ चुका है। रिफ्रेश करें।'),
    'not_found' => ('We couldn\'t find that.', 'यह नहीं मिला।'),
    'not_configured' || 'backend_not_configured' => ('The server isn\'t set up yet.', 'सर्वर अभी तैयार नहीं है।'),
    _ => ('Something went wrong. Please try again.', 'कुछ गड़बड़ हुई। फिर कोशिश करें।'),
  };
  return hi ? hin : en;
}
