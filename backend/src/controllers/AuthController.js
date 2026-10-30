class AuthController {
  async me(req, res) {
    res.json({
      success: true,
      mode: req.authMode,
      user: req.user ? {
        id: req.user.id,
        email: req.user.email,
        role: req.user.role,
        client_id: req.user.clientId,
        display_name: req.user.displayName,
        local_demo: Boolean(req.user.localDemo),
      } : null,
    });
  }
}

export default new AuthController();
