import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setSystemUIOverlayStyle(
    const SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      statusBarIconBrightness: Brightness.light,
    ),
  );
  runApp(const SportsPlusApp());
}

class SportsPlusApp extends StatelessWidget {
  const SportsPlusApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'SportsPlus',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF1565C0),
          primary: const Color(0xFF1565C0),
          secondary: const Color(0xFF7CB342),
          surface: Colors.white,
        ),
        scaffoldBackgroundColor: const Color(0xFFF4F6F9),
        fontFamily: 'Inter',
        appBarTheme: const AppBarTheme(
          backgroundColor: Color(0xFF1565C0),
          foregroundColor: Colors.white,
          elevation: 0,
          centerTitle: true,
        ),
      ),
      home: const MainTabContainer(),
    );
  }
}

class MainTabContainer extends StatefulWidget {
  const MainTabContainer({super.key});

  @override
  State<MainTabContainer> createState() => _MainTabContainerState();
}

class _MainTabContainerState extends State<MainTabContainer> {
  int _currentIndex = 0;

  final List<Widget> _screens = const [
    DashboardView(),
    SchedulesView(),
    RosterView(),
    ChatView(),
    InboxView(),
  ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: IndexedStack(
        index: _currentIndex,
        children: _screens,
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _currentIndex,
        onDestinationSelected: (idx) => setState(() => _currentIndex = idx),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.home_outlined), selectedIcon: Icon(Icons.home), label: 'Home'),
          NavigationDestination(icon: Icon(Icons.calendar_month_outlined), selectedIcon: Icon(Icons.calendar_month), label: 'Schedules'),
          NavigationDestination(icon: Icon(Icons.people_outline), selectedIcon: Icon(Icons.people), label: 'Roster'),
          NavigationDestination(icon: Icon(Icons.chat_bubble_outline), selectedIcon: Icon(Icons.chat_bubble), label: 'Chat'),
          NavigationDestination(icon: Icon(Icons.mail_outline), selectedIcon: Icon(Icons.mail), label: 'Inbox'),
        ],
      ),
    );
  }
}

// 1. Dashboard View (Screenshot 2)
class DashboardView extends StatelessWidget {
  const DashboardView({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SingleChildScrollView(
        child: Column(
          children: [
            // Curved Blue Hero
            Container(
              decoration: const BoxDecoration(
                gradient: LinearGradient(
                  colors: [Color(0xFF1565C0), Color(0xFF0D47A1)],
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                ),
                borderRadius: BorderRadius.vertical(bottom: Radius.circular(36)),
              ),
              padding: const EdgeInsets.fromLTRB(16, 48, 16, 24),
              child: Column(
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      IconButton(icon: const Icon(Icons.menu, color: Colors.white), onPressed: () {}),
                      Row(
                        children: [
                          Stack(
                            children: [
                              IconButton(icon: const Icon(Icons.notifications_outlined, color: Colors.white), onPressed: () {}),
                              Positioned(
                                right: 6,
                                top: 6,
                                child: Container(
                                  padding: const EdgeInsets.all(4),
                                  decoration: const BoxDecoration(color: Colors.red, shape: BoxShape.circle),
                                  child: const Text('66', style: TextStyle(color: Colors.white, fontSize: 10, fontWeight: FontWeight.bold)),
                                ),
                              ),
                            ],
                          ),
                          IconButton(icon: const Icon(Icons.more_vert, color: Colors.white), onPressed: () {}),
                        ],
                      ),
                    ],
                  ),
                  const CircleAvatar(
                    radius: 34,
                    backgroundColor: Colors.white,
                    child: CircleAvatar(radius: 32, backgroundImage: NetworkImage('https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80')),
                  ),
                  const SizedBox(height: 8),
                  const Text('Darel Mitchel', style: TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.bold)),
                  const Text('Player • South Cardos', style: TextStyle(color: Colors.white70, fontSize: 12)),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // Updates Card
                  Card(
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                    child: const Padding(
                      padding: EdgeInsets.all(14),
                      child: Row(
                        children: [
                          Icon(Icons.bolt, color: Color(0xFF8BC34A), size: 28),
                          SizedBox(width: 8),
                          Text('New season about to kickoff', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(height: 16),
                  const Text('🏀 Next Game', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
                  const SizedBox(height: 8),
                  // Next Game Card
                  Card(
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                    child: Padding(
                      padding: const EdgeInsets.all(14),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            mainAxisAlignment: MainAxisAlignment.spaceBetween,
                            children: [
                              const Text('🏀 South Cardos (Home)', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 15)),
                              ElevatedButton(
                                onPressed: () {},
                                style: ElevatedButton.styleFrom(
                                  backgroundColor: const Color(0xFF1976D2),
                                  foregroundColor: Colors.white,
                                  shape: const StadiumBorder(),
                                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 4),
                                ),
                                child: const Text('RSVP', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12)),
                              ),
                            ],
                          ),
                          const Text('Friday, 07 April', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
                          const Text('09:00 AM - 10:00 AM', style: TextStyle(color: Colors.grey, fontSize: 12)),
                          const SizedBox(height: 4),
                          const Text('Super Series Spring Tournament', style: TextStyle(fontSize: 12, color: Colors.grey)),
                          const SizedBox(height: 8),
                          const Text('VS 🏀 Good Hearts (Away)', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
                          const SizedBox(height: 8),
                          Container(
                            padding: const EdgeInsets.all(10),
                            decoration: BoxDecoration(color: const Color(0xFFF1F5F9), borderRadius: BorderRadius.circular(8)),
                            child: const Row(
                              children: [
                                Icon(Icons.location_on, color: Colors.blue, size: 20),
                                SizedBox(width: 8),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Text('Doyle Playing Basketball Court', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12)),
                                      Text('8175 Regents Road San Diego, CA', style: TextStyle(fontSize: 11, color: Colors.grey)),
                                    ],
                                  ),
                                ),
                                Icon(Icons.turn_right, color: Colors.blue),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(height: 16),
                  const Text('👥 My Teams', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
                  const SizedBox(height: 8),
                  Card(
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                    child: const ListTile(
                      leading: CircleAvatar(backgroundColor: Color(0xFFFFF3E0), child: Text('🏀')),
                      title: Text('South Cardos', style: TextStyle(fontWeight: FontWeight.bold)),
                      subtitle: Text('10-15 Years • School Level'),
                      trailing: Text('Player', style: TextStyle(color: Colors.orange, fontWeight: FontWeight.bold)),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// 2. Schedules & Standings View (Task A)
class SchedulesView extends StatelessWidget {
  const SchedulesView({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Fixtures & Standings')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                children: [
                  const Text('Super Series Spring Tournament', style: TextStyle(color: Colors.grey, fontSize: 12)),
                  const SizedBox(height: 8),
                  const Row(
                    mainAxisAlignment: MainAxisAlignment.spaceAround,
                    children: [
                      Column(children: [Text('South Cardos', style: TextStyle(fontWeight: FontWeight.bold)), Text('78', style: TextStyle(fontSize: 28, fontWeight: FontWeight.bold, color: Colors.blue))]),
                      Text('Q4 • LIVE', style: TextStyle(color: Colors.red, fontWeight: FontWeight.bold)),
                      Column(children: [Text('Good Hearts', style: TextStyle(fontWeight: FontWeight.bold)), Text('74', style: TextStyle(fontSize: 28, fontWeight: FontWeight.bold, color: Colors.blue))]),
                    ],
                  ),
                  const Divider(height: 24),
                  ElevatedButton(
                    onPressed: () {},
                    style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFF7CB342), foregroundColor: Colors.white),
                    child: const Text('Buy Official Team Jersey (PKR 4500)'),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// 3. Roster View (Screenshot 3 & 5)
class RosterView extends StatelessWidget {
  const RosterView({super.key});

  final List<Map<String, String>> players = const [
    {'name': 'Correa Brill', 'role': '#3 • Guard'},
    {'name': 'John Burgess', 'role': '#7 • Forward'},
    {'name': 'Addison Burns', 'role': '#12 • Center'},
    {'name': 'Farris Chadson', 'role': '#2 • Guard'},
    {'name': 'Cres Cilyon', 'role': '#9 • Forward'},
    {'name': 'James Neesham', 'role': '#11 • Point Guard'},
    {'name': 'Peter Pohlman', 'role': '#5 • Guard'},
  ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Column(
          children: [
            Text('North Stars', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
            Text('Roster', style: TextStyle(fontSize: 12)),
          ],
        ),
      ),
      body: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: players.length,
        itemBuilder: (ctx, i) {
          final p = players[i];
          return Card(
            margin: const EdgeInsets.only(bottom: 8),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            child: ListTile(
              leading: CircleAvatar(child: Text(p['name']![0])),
              title: Text(p['name']!, style: const TextStyle(fontWeight: FontWeight.bold)),
              subtitle: Text(p['role']!),
              trailing: const Icon(Icons.more_vert),
            ),
          );
        },
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: () {},
        backgroundColor: const Color(0xFF8BC34A),
        child: const Icon(Icons.add, color: Colors.white, size: 28),
      ),
    );
  }
}

// 4. Chat View
class ChatView extends StatelessWidget {
  const ChatView({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('South Cardos Chat')),
      body: const Center(child: Text('South Cardos Team Channel')),
    );
  }
}

// 5. Inbox View
class InboxView extends StatelessWidget {
  const InboxView({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Inbox')),
      body: ListView(
        padding: const EdgeInsets.all(12),
        children: const [
          Card(
            child: ListTile(
              leading: Icon(Icons.notifications, color: Colors.blue),
              title: Text('Next Match Confirmed'),
              subtitle: Text('Super Series vs Good Hearts on Friday 9 AM'),
            ),
          ),
        ],
      ),
    );
  }
}
