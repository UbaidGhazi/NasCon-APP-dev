import 'dart:convert';
import 'package:dio/dio.dart';

class ApiClient {
  static final ApiClient _instance = ApiClient._internal();
  factory ApiClient() => _instance;

  late Dio dio;
  String baseUrl = 'http://10.0.2.2:8080';

  ApiClient._internal() {
    dio = Dio(BaseOptions(
      baseUrl: baseUrl,
      connectTimeout: const Duration(seconds: 10),
      receiveTimeout: const Duration(seconds: 10),
      headers: {'Content-Type': 'application/json'},
    ));
  }

  void updateBaseUrl(String url) {
    baseUrl = url;
    dio.options.baseUrl = url;
  }

  void setToken(String token) {
    dio.options.headers['Authorization'] = 'Bearer $token';
  }
}
