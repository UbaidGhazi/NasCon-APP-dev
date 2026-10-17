import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Secure token storage backed by Android Keystore (NFR-5)
class TokenStore {
  static const _storage = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  static const _jwtKey = 'jwt_token';
  static const _roleKey = 'user_role';

  static Future<void> saveToken(String token, String role) async {
    await _storage.write(key: _jwtKey, value: token);
    await _storage.write(key: _roleKey, value: role);
  }

  static Future<String?> getToken() async {
    return await _storage.read(key: _jwtKey);
  }

  static Future<String?> getRole() async {
    return await _storage.read(key: _roleKey);
  }

  static Future<void> clear() async {
    await _storage.deleteAll();
  }
}
