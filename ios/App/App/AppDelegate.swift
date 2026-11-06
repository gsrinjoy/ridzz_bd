import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}

// Kept in this file so it needs no change to the Xcode project.

import AVFoundation
import CoreLocation

/// Registers the app's own plugin once the web view is ready.
class RideViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(RideShellPlugin())
    }
}

/// The iPhone side of a ride, matching the Android plugin. iOS only lets an app use the
/// mic and GPS with the screen locked when it is native and declares these background modes.
@objc(RideShellPlugin)
public class RideShellPlugin: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate {
    public let identifier = "RideShellPlugin"
    public let jsName = "RideShell"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listRoutes", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRoute", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestBatteryExemption", returnType: CAPPluginReturnPromise)
    ]

    private let location = CLLocationManager()
    private var speakerForced = false

    @objc func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            do {
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .defaultToSpeaker])
                try session.setActive(true)
            } catch {
                call.reject("Could not start audio: \(error.localizedDescription)")
                return
            }
            self.location.delegate = self
            self.location.desiredAccuracy = kCLLocationAccuracyBest
            self.location.distanceFilter = 5
            self.location.activityType = .automotiveNavigation
            self.location.pausesLocationUpdatesAutomatically = false
            self.location.requestWhenInUseAuthorization()
            self.location.allowsBackgroundLocationUpdates = true
            self.location.showsBackgroundLocationIndicator = true
            self.location.startUpdatingLocation()
            call.resolve(["headset": self.headsetName()])
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.location.stopUpdatingLocation()
            self.location.allowsBackgroundLocationUpdates = false
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            call.resolve()
        }
    }

    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let fix = locations.last else { return }
        notifyListeners("location", data: [
            "la": fix.coordinate.latitude,
            "lo": fix.coordinate.longitude,
            "sp": max(0, fix.speed) * 3.6,
            "hd": fix.course,
            "ts": fix.timestamp.timeIntervalSince1970 * 1000
        ])
    }

    private func isBluetooth(_ port: AVAudioSession.Port) -> Bool {
        return port == .bluetoothHFP || port == .bluetoothA2DP || port == .bluetoothLE
    }

    private func headsetName() -> String {
        let session = AVAudioSession.sharedInstance()
        return session.currentRoute.outputs.first(where: { isBluetooth($0.portType) })?.portName ?? ""
    }

    /// Every place a call can go right now, for the Speaker button on the call deck.
    @objc func listRoutes(_ call: CAPPluginCall) {
        let session = AVAudioSession.sharedInstance()
        let activeInput = session.currentRoute.inputs.first?.uid
        var routes: [[String: Any]] = [
            ["id": "speaker", "label": "Phone speaker", "kind": "speaker", "active": speakerForced]
        ]
        for input in session.availableInputs ?? [] {
            let bluetooth = isBluetooth(input.portType)
            let builtIn = input.portType == .builtInMic
            routes.append([
                "id": input.uid,
                "label": builtIn ? "Phone earpiece" : input.portName,
                "kind": bluetooth ? "bluetooth" : (builtIn ? "earpiece" : "wired"),
                "active": !speakerForced && input.uid == activeInput
            ])
        }
        call.resolve(["routes": routes])
    }

    @objc func setRoute(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        let session = AVAudioSession.sharedInstance()
        do {
            if id == "speaker" {
                try session.overrideOutputAudioPort(.speaker)
                speakerForced = true
            } else {
                try session.overrideOutputAudioPort(.none)
                speakerForced = false
                if let port = session.availableInputs?.first(where: { $0.uid == id }) {
                    try session.setPreferredInput(port)
                }
            }
            call.resolve()
        } catch {
            call.reject("That audio route is not available")
        }
    }

    /// iOS has no equivalent of Android's battery exemption.
    @objc func requestBatteryExemption(_ call: CAPPluginCall) {
        call.resolve(["exempt": true])
    }
}
