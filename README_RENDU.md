## A. Instrumenter l'application

S'assurer qu'en cas de shutdown, les traces et métriques en attente soient bien exportées :
![shutdown-open-telemetry](screenshots/shutdown-open-telemetry.png)

Il faut se gréffer sur l'évènement shutdown du process pour faire un `sdk.shutdown()`
