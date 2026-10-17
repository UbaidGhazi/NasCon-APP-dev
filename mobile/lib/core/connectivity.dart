import 'dart:async';
import 'package:connectivity_plus/connectivity_plus.dart';

enum NetworkStatus { online, offline, syncing }

class ConnectivityService {
  static final _controller = StreamController<NetworkStatus>.broadcast();
  static Stream<NetworkStatus> get statusStream => _controller.stream;

  static bool _isAirplaneMode = false;
  static bool get isOffline => _isAirplaneMode;

  static void setAirplaneMode(bool enabled) {
    _isAirplaneMode = enabled;
    _controller.add(enabled ? NetworkStatus.offline : NetworkStatus.online);
  }
}
